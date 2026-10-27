import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Lobby, RoomError, send } from './rooms.js';
import { staticHandler } from './static.js';

const MAX_MESSAGE_BYTES = 256 * 1024; // a full game save (every hand, the log) fits comfortably
const RATE_PER_SECOND = 100;         // burst allowance per socket, refilled every second (host: snapshots + saves)
const HEARTBEAT_MS = 15_000;

// One HTTP server: GET /healthz, WebSocket upgrades on /ws, everything else is the WebGL build from publicDir.
export function createServer({ publicDir, graceMs, idleMs, maxRooms, log = console.log } = {}) {
  const lobby = new Lobby({ graceMs, idleMs, maxRooms, log });
  const serveStatic = staticHandler(publicDir);

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, ...lobby.stats() }));
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

  wss.on('connection', (ws) => {
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
      try {
        handle(lobby, ws, msg);
      } catch (err) {
        if (err instanceof RoomError) fail(ws, err.code, err.message);
        else {
          log(`error handling ${msg?.t}: ${err.stack ?? err}`);
          fail(ws, 'internal', 'Lỗi máy chủ');
        }
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

  return { server, wss, lobby };
}

function handle(lobby, ws, msg) {
  switch (msg?.t) {
    case 'create': return void lobby.create(ws, msg.name);
    case 'join': return void lobby.join(ws, msg.room, msg.name);
    case 'rejoin': return void lobby.rejoin(ws, msg.room, msg.token);
    case 'start': return lobby.start(ws);
    case 'kick': return lobby.kick(ws, msg.seat);
    case 'save': return lobby.save(ws, msg.data);
    case 'send': return lobby.relay(ws, msg.to, msg.data);
    case 'leave': return lobby.leave(ws);
    case 'ping': return send(ws, { t: 'pong' });
    default: throw new RoomError('bad_message', `Không rõ lệnh: ${msg?.t}`);
  }
}

function fail(ws, code, message) {
  send(ws, { t: 'error', code, message });
}
