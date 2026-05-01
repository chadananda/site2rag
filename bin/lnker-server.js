// Archive static server -- maps {domain}.lnker.com requests to websites_mirror/{domain}/.
// One server handles all lnker.com subdomains via Host header routing.
// Robots: all subdomains are noindex/nofollow (private archive, not for search engines).
// Caching: sets Cache-Control so Cloudflare edge can cache everything after first request.
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { getMirrorRoot } from '../src/config.js';

const PORT = parseInt(process.env.LNKER_PORT || '7841', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.txt':  'text/plain; charset=utf-8',
  '.ico':  'image/x-icon',
  '.xml':  'application/xml',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

// Cache TTLs by content type category (in seconds)
// Cloudflare will honour these; assets get longer TTL than HTML
const cacheTtl = (ext) => {
  if (['.css','.js','.woff','.woff2','.ttf'].includes(ext)) return 'public, max-age=2592000, immutable'; // 30 days
  if (['.png','.jpg','.jpeg','.gif','.webp','.svg','.ico'].includes(ext)) return 'public, max-age=604800'; // 7 days
  if (ext === '.pdf') return 'public, max-age=86400'; // 1 day
  return 'public, max-age=3600'; // 1 hour for HTML, XML, etc.
};

const ROBOTS_BLOCK = 'User-agent: *\nDisallow: /\n';

const baseHeaders = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'X-Served-By': 'lnker',
};

const serve = (res, status, body, type = 'text/plain', ext = '') => {
  res.writeHead(status, {
    ...baseHeaders,
    'Content-Type': type,
    'Cache-Control': status === 200 ? cacheTtl(ext) : 'no-store',
  });
  res.end(body);
};

createServer((req, res) => {
  // Extract domain from Host header: bahai-library.lnker.com -> bahai-library.com
  const host = (req.headers.host || '').split(':')[0];
  const domain = host.replace(/\.lnker\.com$/, '');
  if (!domain || domain === host) return serve(res, 400, 'Invalid host -- expected {domain}.lnker.com');

  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Robots.txt: always block crawlers regardless of domain
  if (urlPath === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=86400', ...baseHeaders });
    return res.end(ROBOTS_BLOCK);
  }

  const mirrorRoot = getMirrorRoot();
  const domainRoot = join(mirrorRoot, domain);
  if (!existsSync(domainRoot)) return serve(res, 404, `Domain ${domain} not mirrored`);

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
  serve(res, 200, readFileSync(filePath), mime, ext);

}).listen(PORT, '127.0.0.1', () => {
  console.log(`[lnker-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[lnker-server] serving ${getMirrorRoot()}/{domain} via {domain}.lnker.com`);
});
