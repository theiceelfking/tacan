import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Lobby, RoomError, send } from './rooms.js';
import { staticHandler } from './static.js';
import { Accounts, LoginLimiter } from './accounts.js';

const MAX_MESSAGE_BYTES = 256 * 1024; // a full game save (every hand, the log) fits comfortably
const RATE_PER_SECOND = 100;         // burst allowance per socket, refilled every second (host: snapshots + saves)
const HEARTBEAT_MS = 15_000;

// One HTTP server: GET /healthz, WebSocket upgrades on /ws, everything else is the WebGL build from publicDir.
// Accounts live in dataDir (nothing is kept on disk without one). trustProxy: take the client address from
// X-Forwarded-For, for login rate limits behind nginx / Caddy.
export function createServer({
  publicDir, dataDir, graceMs, idleMs, maxRooms, trustProxy = false, loginLimit, log = console.log,
} = {}) {
  const lobby = new Lobby({ graceMs, idleMs, maxRooms, log });
  const accounts = new Accounts({ dataDir });
  const limiter = new LoginLimiter(loginLimit);
  const serveStatic = staticHandler(publicDir);

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...lobby.stats(), ...accounts.stats() }));
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    ws.addr = fwd || req.socket.remoteAddress || '?';
    ws.user = null; // account name once logged in
    ws.room = null;
    ws.seat = -1;
    ws.alive = true;
    ws.budget = RATE_PER_SECOND;
    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return fail(ws, 'bad_message', 'Chỉ nhận JSON dạng text');
      if (--ws.budget < 0) return fail(ws, 'rate_limited', 'Gửi quá nhanh');
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail(ws, 'bad_message', 'JSON không hợp lệ');
      }
      const onError = (err) => {
        if (err instanceof RoomError) fail(ws, err.code, err.message);
        else {
          log(`error handling ${msg?.t}: ${err.stack ?? err}`);
          fail(ws, 'internal', 'Lỗi máy chủ');
        }
      };
      try {
        const r = handle({ lobby, accounts, limiter, log }, ws, msg);
        if (r instanceof Promise) r.catch(onError);
      } catch (err) {
        onError(err);
      }
    });
    ws.on('close', () => lobby.disconnected(ws));
    ws.on('error', () => {});
  });

  // Drop sockets that stopped answering pings (phone went to sleep, network changed) and refill rate budgets.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const refill = setInterval(() => {
    for (const ws of wss.clients) ws.budget = RATE_PER_SECOND;
  }, 1000);
  heartbeat.unref();
  refill.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(refill);
  });

  return { server, wss, lobby, accounts };
}

function handle({ lobby, accounts, limiter, log }, ws, msg) {
  switch (msg?.t) {
    case 'register': return auth(ws, limiter, () => accounts.register(msg.name, msg.password), log, 'registered');
    case 'login': return auth(ws, limiter, () => accounts.login(msg.name, msg.password));
    case 'logout':
      accounts.logout(msg.session);
      ws.user = null;
      return send(ws, { t: 'loggedout' });
    case 'ping': return send(ws, { t: 'pong' });
  }
  // Everything else needs an account: logged in on this socket, or a session sent along with the message.
  if (!ws.user && msg?.session !== undefined) {
    ws.user = accounts.verify(msg.session);
    if (!ws.user) throw new RoomError('bad_session', 'Phiên đăng nhập đã hết hạn, đăng nhập lại');
  }
  if (!ws.user && msg?.t !== undefined) throw new RoomError('auth_required', 'Cần đăng nhập trước');
  switch (msg?.t) {
    case 'create': return void lobby.create(ws, ws.user);
    case 'join': return void lobby.join(ws, msg.room, ws.user);
    case 'rejoin': return void lobby.rejoin(ws, msg.room, msg.token);
    case 'start': return lobby.start(ws);
    case 'kick': return lobby.kick(ws, msg.seat);
    case 'save': return lobby.save(ws, msg.data);
    case 'send': return lobby.relay(ws, msg.to, msg.data);
    case 'leave': return lobby.leave(ws);
    default: throw new RoomError('bad_message', `Không rõ lệnh: ${msg?.t}`);
  }
}

// register / login: one at a time per socket, failures counted per address.
async function auth(ws, limiter, run, log, what) {
  if (ws.authBusy) throw new RoomError('busy', 'Đang xử lý, đợi chút');
  limiter.check(ws.addr);
  ws.authBusy = true;
  try {
    const { name, session } = await run();
    ws.user = name;
    if (what) log?.(`account ${what}: ${name}`);
    send(ws, { t: 'authed', name, session });
  } catch (err) {
    if (err instanceof RoomError) limiter.failed(ws.addr);
    throw err;
  } finally {
    ws.authBusy = false;
  }
}

function fail(ws, code, message) {
  send(ws, { t: 'error', code, message });
}
