// Lightweight static file server for the PDF upgrade report. Serves UPGRADE_REPORT_PATH on PORT.
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { getSiteRoot } from '../src/config.js';
const PORT = parseInt(process.env.REPORT_PORT || '7840', 10);
const ROOT = process.env.UPGRADE_REPORT_PATH || join(getSiteRoot(), 'report');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.ico': 'image/x-icon' };
const serve = (res, status, body, type = 'text/plain') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body); };
createServer((req, res) => {
  const url = req.url.split('?')[0];
  const filePath = join(ROOT, url === '/' ? 'index.html' : url);
  if (!filePath.startsWith(ROOT)) return serve(res, 403, 'Forbidden');
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const idx = join(filePath, 'index.html');
    if (existsSync(idx)) return serve(res, 200, readFileSync(idx), 'text/html; charset=utf-8');
    return serve(res, 404, 'Not found');
  }
  serve(res, 200, readFileSync(filePath), MIME[extname(filePath)] || 'application/octet-stream');
}).listen(PORT, '127.0.0.1', () => console.log(`[report-server] http://127.0.0.1:${PORT} → ${ROOT}`));
