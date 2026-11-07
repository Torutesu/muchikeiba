// Local static server for the built console (dist/). Production hosting: any static host behind Cloudflare Access
// (docs/ops/console.md). Usage: node serve.mjs [port] [dir]   (binds 127.0.0.1 only)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? process.env.OPS_CONSOLE_PORT ?? 9217);
const root = normalize(process.argv[3] ?? join(here, 'dist'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const headers = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403, headers).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, headers).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`ops console on http://127.0.0.1:${port} (${root})`));
