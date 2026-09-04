// Minimal static server for local review of docs/. No dependencies.
//   node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { ROOT } from './screener.mjs';

const port = Number(process.argv[2]) || 8080;
const DOCS = join(ROOT, 'docs');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

createServer((req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    // normalise then confine to docs/ so ../ cannot escape the directory
    let target = normalize(join(DOCS, url === '/' ? 'index.html' : url));

    // Directory requests ("/demo/") resolve to index.html, the way GitHub
    // Pages does it -- otherwise reading the directory throws.
    if (existsSync(target) && statSync(target).isDirectory()) {
      target = join(target, 'index.html');
    }

    if (!target.startsWith(DOCS) || !existsSync(target)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(target));
  } catch (err) {
    // Never let one bad request take the server down.
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`server error: ${err.message}`);
  }
}).listen(port, () => {
  console.log(`Screener Tracker  → http://localhost:${port}`);
  console.log(`Demo (full data)  → http://localhost:${port}/demo/`);
});
