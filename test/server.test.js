import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';

let srv, base, wsUrl;

before(async () => {
  const pub = mkdtempSync(path.join(tmpdir(), 'catan-pub-'));
  writeFileSync(path.join(pub, 'index.html'), '<h1>catan</h1>');
  mkdirSync(path.join(pub, 'Build'));
  writeFileSync(path.join(pub, 'Build', 'game.wasm.br'), 'fake');
  srv = createServer({ publicDir: pub, graceMs: 200, idleMs: 300, log: () => {} });
  await new Promise((r) => srv.server.listen(0, r));
  const { port } = srv.server.address();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(() => {
  for (const ws of srv.wss.clients) ws.terminate();
  srv.server.close();
});

// A test client that queues incoming messages so tests can await them in order.
async function client() {
  const ws = new WebSocket(wsUrl);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.t === msg.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  await new Promise((r, j) => ws.once('open', r).once('error', j));
  return {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(t) {
      const i = queue.findIndex((m) => m.t === t);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { t, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 2000).unref();
      });
    },
    drain() { queue.length = 0; },
    close: () => ws.close(),
  };
}

test('serves static files, precompressed builds and health', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /catan/);

  const wasm = await fetch(`${base}/Build/game.wasm.br`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal(wasm.headers.get('content-encoding'), 'br');
  await wasm.arrayBuffer().catch(() => {}); // body is not real brotli

  assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2f..%2fetc/passwd`)).status, 403);

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
});

test('create, join, relay rules and start', async () => {
  const host = await client();
  host.send({ t: 'create', name: 'Chủ' });
  const hw = await host.next('welcome');
  assert.equal(hw.seat, 0);
  assert.equal(hw.host, true);
  assert.match(hw.room, /^[A-Z2-9]{5}$/);

  const a = await client();
  a.send({ t: 'join', room: hw.room.toLowerCase(), name: 'An' });
  const aw = await a.next('welcome');
  assert.equal(aw.seat, 1);
  const b = await client();
  b.send({ t: 'join', room: hw.room, name: 'Bình' });
  assert.equal((await b.next('welcome')).seat, 2);

  let room = await host.next('room');
  while (room.players.length < 3) room = await host.next('room');
  assert.deepEqual(room.players.map((p) => p.name), ['Chủ', 'An', 'Bình']);

  // guest -> host only, even if the guest names another seat
  a.send({ t: 'send', to: 2, data: { act: 'roll' } });
  assert.deepEqual(await host.next('msg'), { t: 'msg', from: 1, data: { act: 'roll' } });

  // host -> everyone, host -> one seat
  host.send({ t: 'send', data: { state: 1 } });
  assert.deepEqual((await a.next('msg')).data, { state: 1 });
  assert.deepEqual((await b.next('msg')).data, { state: 1 });
  host.send({ t: 'send', to: 2, data: { hand: [1, 2] } });
  assert.deepEqual((await b.next('msg')).data, { hand: [1, 2] });

  // only the host may start; started rooms refuse newcomers
  a.send({ t: 'start' });
  assert.equal((await a.next('error')).code, 'not_host');
  host.send({ t: 'start' });
  let br = await b.next('room');
  while (!br.started) br = await b.next('room');
  const late = await client();
  late.send({ t: 'join', room: hw.room, name: 'Muộn' });
  assert.equal((await late.next('error')).code, 'room_started');

  // the host keeps a full save on the server; when the host leaves, the next online seat takes over with it
  host.send({ t: 'save', data: 'FULL-GAME' });
  a.send({ t: 'save', data: 'forged' });
  assert.equal((await a.next('error')).code, 'not_host');
  host.send({ t: 'leave' });
  const promoted = await a.next('promote');
  assert.equal(promoted.data, 'FULL-GAME');
  let ar = await a.next('room');
  while (ar.hostSeat !== 1) ar = await a.next('room');
  assert.equal(ar.players.find((p) => p.seat === 0).online, false);   // the old host's seat stays theirs

  // relay now follows the new host
  b.send({ t: 'send', data: 'to new host' });
  assert.deepEqual(await a.next('msg'), { t: 'msg', from: 2, data: 'to new host' });
  a.send({ t: 'send', data: 'snap' });
  assert.equal((await b.next('msg')).data, 'snap');

  // the old host comes back with their token, as a guest
  const back = await client();
  back.send({ t: 'rejoin', room: hw.room, token: hw.token });
  const bw = await back.next('welcome');
  assert.equal(bw.seat, 0);
  assert.equal(bw.host, false);
  assert.equal(bw.hostSeat, 1);
  back.send({ t: 'send', data: 'back' });
  assert.deepEqual(await a.next('msg'), { t: 'msg', from: 0, data: 'back' });
  for (const c of [host, a, b, late, back]) c.close();
});

test('rejoin with token after a dropped connection', async () => {
  const host = await client();
  host.send({ t: 'create', name: 'H' });
  const { room } = await host.next('welcome');
  const g = await client();
  g.send({ t: 'join', room, name: 'G' });
  const { token, seat } = await g.next('welcome');
  g.ws.terminate();

  let r = await host.next('room');
  while (r.players.find((p) => p.seat === seat)?.online !== false) r = await host.next('room');

  const g2 = await client();
  g2.send({ t: 'rejoin', room, token: 'wrong' });
  assert.equal((await g2.next('error')).code, 'bad_token');
  g2.send({ t: 'rejoin', room, token });
  const w = await g2.next('welcome');
  assert.equal(w.seat, seat);

  g2.send({ t: 'send', data: 'hi' });
  assert.equal((await host.next('msg')).data, 'hi');
  host.close();
  g2.close();
});

test('everyone offline: the room waits, then the first one back is host', async () => {
  const host = await client();
  host.send({ t: 'create', name: 'H' });
  const hw = await host.next('welcome');
  const g = await client();
  g.send({ t: 'join', room: hw.room, name: 'G' });
  const gw = await g.next('welcome');
  host.send({ t: 'start' });
  host.send({ t: 'save', data: 'S1' });
  host.send({ t: 'ping' });
  await host.next('pong');   // the save has arrived before the socket dies
  host.ws.terminate();
  assert.equal((await g.next('promote')).data, 'S1');
  g.ws.terminate();
  await new Promise((r) => setTimeout(r, 100));

  const g2 = await client();
  g2.send({ t: 'rejoin', room: hw.room, token: gw.token });
  const w = await g2.next('welcome');
  assert.equal(w.seat, 1);
  assert.equal(w.host, true);   // already host when everyone left
  const h2 = await client();
  h2.send({ t: 'rejoin', room: hw.room, token: hw.token });
  assert.equal((await h2.next('welcome')).hostSeat, 1);
  g2.close();
  h2.close();
});

test('an empty started room closes after idleMs', async () => {
  const host = await client();
  host.send({ t: 'create', name: 'H' });
  const hw = await host.next('welcome');
  host.send({ t: 'start' });
  await host.next('room');
  host.ws.terminate();
  await new Promise((r) => setTimeout(r, 450));
  const c = await client();
  c.send({ t: 'rejoin', room: hw.room, token: hw.token });
  assert.equal((await c.next('error')).code, 'no_room');
  c.close();
});

test('seat is freed after the grace period in the lobby; host role moves on', async () => {
  const host = await client();
  host.send({ t: 'create', name: 'H' });
  const { room } = await host.next('welcome');
  const g = await client();
  g.send({ t: 'join', room, name: 'G' });
  await g.next('welcome');
  g.ws.terminate();
  await new Promise((r) => setTimeout(r, 350));
  host.drain();

  const g2 = await client();
  g2.send({ t: 'join', room, name: 'G2' });
  assert.equal((await g2.next('welcome')).seat, 1);

  host.ws.terminate();
  await g2.next('promote');
  host.close();
  g2.close();
});

test('rejects garbage and unknown rooms', async () => {
  const c = await client();
  c.ws.send('not json');
  assert.equal((await c.next('error')).code, 'bad_message');
  c.send({ t: 'join', room: 'ZZZZZ' });
  assert.equal((await c.next('error')).code, 'no_room');
  c.send({ t: 'send', data: 1 });
  assert.equal((await c.next('error')).code, 'not_in_room');
  c.close();
});
