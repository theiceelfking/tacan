import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// Serves the Unity WebGL build. Unity can pre-compress its output (Build/*.br or *.gz); those files must go out
// with Content-Encoding and the type of the file underneath, otherwise the loader refuses them.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.symbols.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const ENCODINGS = { '.br': 'br', '.gz': 'gzip', '.unityweb': null };

export function staticHandler(root) {
  root = path.resolve(root);
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      info = null;
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }

    let name = path.basename(file).toLowerCase();
    const headers = { 'Content-Length': info.size };
    const ext = path.extname(name);
    if (ext in ENCODINGS) {
      if (ENCODINGS[ext]) headers['Content-Encoding'] = ENCODINGS[ext];
      name = name.slice(0, -ext.length);
    }
    headers['Content-Type'] = contentType(name);
    // Build/ file names stay the same between builds, so browsers (and Cloudflare) must check back each time;
    // the ETag turns an unchanged file into a 304 with no body.
    const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    headers['Cache-Control'] = 'no-cache';
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
      return;
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };
}

function contentType(name) {
  if (name.endsWith('.symbols.json')) return TYPES['.symbols.json'];
  return TYPES[path.extname(name)] ?? 'application/octet-stream';
}
