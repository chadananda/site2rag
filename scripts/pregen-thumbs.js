// Bulk pre-generate thumbnails for all PDF pages across all sites.
// Usage: node scripts/pregen-thumbs.js [--pages N] [--site domain]
//   --pages N   generate first N pages per PDF (default: 5)
//   --site      only process a specific domain
// Runs a pool of pdfjs worker threads scaled to CPU count.
import { Worker } from 'worker_threads';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cpus } from 'os';
import { createHash } from 'crypto';
import { loadConfig, getMirrorRoot } from '../src/config.js';
import { openDb } from '../src/db.js';

const WORKER_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/thumb-worker.js');
const CONCURRENCY = Math.max(4, Math.floor(cpus().length * 0.75));
const THUMB_W = 800;

const args = process.argv.slice(2);
const maxPages = parseInt(args[args.indexOf('--pages') + 1] || '5', 10);
const filterSite = args[args.indexOf('--site') + 1] || null;

const cfg = loadConfig();
const mirrorRoot = getMirrorRoot();
const sites = (cfg.sites || []).filter(s => !filterSite || s.domain === filterSite);

// Worker pool
const pool = [];
const queue = [];
let _jobId = 0;
const _pending = new Map();

const dispatch = (slot) => {
  if (!queue.length) { slot.busy = false; return; }
  const job = queue.shift();
  slot.busy = true;
  slot.worker.postMessage(job);
};

for (let i = 0; i < CONCURRENCY; i++) {
  const slot = { busy: false, worker: new Worker(WORKER_SCRIPT) };
  slot.worker.on('message', ({ jobId, success, error }) => {
    const p = _pending.get(jobId); _pending.delete(jobId);
    if (p) (success ? p.resolve : p.reject)(success ? undefined : new Error(error));
    dispatch(slot);
  });
  slot.worker.on('error', () => dispatch(slot));
  pool.push(slot);
}

const generateThumb = (pdfPath, outPath, pageNo) =>
  new Promise((resolve, reject) => {
    const jobId = ++_jobId;
    _pending.set(jobId, { resolve, reject });
    const free = pool.find(w => !w.busy);
    if (free) { free.busy = true; free.worker.postMessage({ jobId, pdfPath, outPath, targetW: THUMB_W, pageNo }); }
    else queue.push({ jobId, pdfPath, outPath, targetW: THUMB_W, pageNo });
  });

let total = 0, skipped = 0, errors = 0;
const t0 = Date.now();

for (const site of sites) {
  const db = openDb(site.domain);
  const thumbDir = join(mirrorRoot, site.domain, '.thumbs');
  mkdirSync(thumbDir, { recursive: true });

  const pdfs = db.prepare(`
    SELECT p.local_path, p.url, COALESCE(q.pages, 1) as pages
    FROM pages p
    LEFT JOIN pdf_quality q ON p.url=q.url
    WHERE p.mime_type='application/pdf' AND p.gone=0 AND p.local_path IS NOT NULL
  `).all().filter(r => existsSync(r.local_path));

  db.close();
  console.log(`[${site.domain}] ${pdfs.length} PDFs, up to ${maxPages} pages each`);

  const jobs = [];
  for (const { local_path, url, pages } of pdfs) {
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const numPages = Math.min(pages, maxPages);
    for (let p = 1; p <= numPages; p++) {
      const outPath = join(thumbDir, `x${hash}_p${p}_${THUMB_W}w.jpg`);
      if (existsSync(outPath)) { skipped++; continue; }
      jobs.push({ pdfPath: local_path, outPath, pageNo: p });
    }
  }

  console.log(`[${site.domain}] ${jobs.length} thumbnails to generate (${skipped} already cached)`);

  // Run in chunks of CONCURRENCY
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(
      jobs.slice(i, i + CONCURRENCY).map(({ pdfPath, outPath, pageNo }) =>
        generateThumb(pdfPath, outPath, pageNo)
          .then(() => { total++; if (total % 500 === 0) console.log(`  ${total} done…`); })
          .catch(() => { errors++; })
      )
    );
  }
}

for (const slot of pool) slot.worker.terminate();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone: ${total} generated, ${skipped} skipped, ${errors} errors in ${elapsed}s (${CONCURRENCY} workers)`);
