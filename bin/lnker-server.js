// Archive static server -- maps {domain}.lnker.com requests to websites_mirror/{domain}/.
// One server handles all lnker.com subdomains via Host header routing.
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { getMirrorRoot } from '../src/config.js';
const PORT = parseInt(process.env.LNKER_PORT || '7841', 10);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
};
const serve = (res, status, body, type = 'text/plain') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Served-By': 'lnker' });
  res.end(body);
};
createServer((req, res) => {
  // Extract domain from Host header: bahai-library.lnker.com -> bahai-library.com
  const host = (req.headers.host || '').split(':')[0];
  const domain = host.replace(/\.lnker\.com$/, '');
  if (!domain || domain === host) return serve(res, 400, 'Invalid host -- expected {domain}.lnker.com');
  const mirrorRoot = getMirrorRoot();
  const domainRoot = join(mirrorRoot, domain);
  if (!existsSync(domainRoot)) return serve(res, 404, `Domain ${domain} not mirrored`);
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = join(domainRoot, urlPath);
  // Prevent path traversal
  if (!filePath.startsWith(domainRoot)) return serve(res, 403, 'Forbidden');
  // Directory -> try index.html
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  // No extension -> try index.html
  if (!extname(filePath) && !existsSync(filePath)) filePath = join(filePath, 'index.html');
  if (!existsSync(filePath)) return serve(res, 404, `Not found: ${urlPath}`);
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  serve(res, 200, readFileSync(filePath), mime);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[lnker-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[lnker-server] serving ${getMirrorRoot()}/{domain} via {domain}.lnker.com`);
});
