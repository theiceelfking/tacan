import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8080);
const publicDir = process.env.PUBLIC_DIR ?? path.join(here, '..', 'public');
const graceMs = Number(process.env.RECONNECT_GRACE_MS ?? 60_000);
const idleMs = Number(process.env.ROOM_IDLE_MS ?? 10 * 60_000);
const maxRooms = Number(process.env.MAX_ROOMS ?? 1000);
const dataDir = process.env.DATA_DIR ?? path.join(here, '..', 'data');
const trustProxy = process.env.TRUST_PROXY === '1';

const { server, wss } = createServer({ publicDir, dataDir, graceMs, idleMs, maxRooms, trustProxy });
server.listen(port, () => console.log(`catan server on :${port} (static: ${publicDir}, data: ${dataDir})`));

// Docker sends SIGTERM on stop: tell clients, then exit.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
