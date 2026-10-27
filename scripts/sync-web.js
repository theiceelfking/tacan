// Copy the Unity WebGL build (Catan > Build Web, output ../Builds/Web) into public/ so the server and the
// Docker image ship it. Usage: npm run sync-web [-- path/to/WebBuild]
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.argv[2] ?? path.join(root, '..', 'Builds', 'Web'));
const dst = path.join(root, 'public');

if (!existsSync(path.join(src, 'index.html'))) {
  console.error(`No WebGL build at ${src} (run Catan > Build Web in Unity first)`);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log(`copied ${src} -> ${dst}`);
