// One-time recovery for SLP jobs rejected before the metadata-stage fix.
// Looks each failed doc up by PDF SHA-256 via SLP /jobs?hash, re-fetches the
// corrected result, re-validates (title/subject/markdown), saves done + acks
// delivery. 404 → re-queue for fresh submit; still-incomplete → ack validated:false.
// Runs on tower-nas (local DB, mirror, SLP). Deps: better-sqlite3.
// Usage: node recover-slp-metadata.js [--dry] [--limit N] [--filter "<SQL after error>"]

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { request } from 'http';

const SLP    = process.env.PIPELINE_URL || 'http://localhost:49900';
const DOMAIN = process.env.RECOVER_DOMAIN || 'bahai-library.com';
const ROOT   = process.env.SITE2RAG_ROOT || '/tank/site2rag';
const MIRROR = join(ROOT, 'websites_mirror', DOMAIN);
const DB     = join(MIRROR, '_meta', 'site.sqlite');
const UPGRADED = join(MIRROR, '.upgraded');

const argv = process.argv.slice(2);
const DRY  = argv.includes('--dry');
const LIMIT = argv.includes('--limit') ? parseInt(argv[argv.indexOf('--limit') + 1], 10) : 0;
const FILTER = argv.includes('--filter') ? argv[argv.indexOf('--filter') + 1] : "error LIKE 'incomplete:%'";

const LANG_NAMES = new Set(['arabic','persian','hebrew','french','spanish','german','italian','portuguese','dutch','polish','turkish','russian','japanese','chinese','korean','english','unknown']);
const stripQuotes = s => s ? s.replace(/^["«»「」『』"']+|["«»「」『』"']+$/g, '').trim() : s;
const hashQuery = q => createHash('sha256').update(q).digest('hex').slice(0, 4);

// Mirror path mapping — mirrors src/mirror-crawl.js urlToMirrorPath.
function urlToPath(urlStr) {
  const u = new URL(urlStr);
  let p = u.pathname;
  if (p.endsWith('/') || !extname(p)) p = p.replace(/\/?$/, '/index.html');
  if (u.search) { const ext = extname(p); p = `${p.slice(0, -ext.length)}__${hashQuery(u.search)}${ext}`; }
  const parts = p.split('/'); const last = parts[parts.length - 1];
  if (Buffer.byteLength(last, 'utf8') > 200) {
    const ext = extname(last) || '';
    parts[parts.length - 1] = `${createHash('sha256').update(last).digest('hex').slice(0, 12)}${ext}`;
    p = parts.join('/');
  }
  return join(MIRROR, p.replace(/^\//, ''));
}

function httpGet(path, type = 'json') {
  return new Promise((resolve, reject) => {
    request(SLP + path, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        const buf = Buffer.concat(chunks);
        if (type === 'buffer') return resolve(buf);
        if (type === 'text')   return resolve(buf.toString('utf8'));
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch { reject(new Error('bad JSON')); }
      });
    }).on('error', reject).end();
  });
}

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(SLP + path);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}: ${d}`)) : resolve(d));
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

const log = (...a) => console.log(...a);

async function main() {
  const db = new Database(DB);
  mkdirSync(UPGRADED, { recursive: true });
  const rows = db.prepare(
    `SELECT url FROM pdf_upgrade_queue WHERE status='failed' AND (${FILTER}) ORDER BY finished_at DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`
  ).all();

  log(`${DRY ? '[DRY] ' : ''}Recovering ${rows.length} failed docs (filter: ${FILTER})\n`);
  const stats = { recovered: 0, still_failed: 0, requeued: 0, no_local_pdf: 0, errors: 0 };

  for (const { url } of rows) {
    try {
      const pdf = urlToPath(url);
      if (!existsSync(pdf)) { stats.no_local_pdf++; log('NO-PDF  ', url); continue; }
      const hash = createHash('sha256').update(readFileSync(pdf)).digest('hex');

      const lookup = await httpGet(`/jobs?hash=${hash}`).catch(e => ({ _err: e.message }));
      const jobs = lookup?.jobs || [];
      const done = jobs.find(j => j.status === 'done');
      if (!done) {
        if (!DRY) db.prepare("DELETE FROM pdf_upgrade_queue WHERE url=?").run(url);
        stats.requeued++; log('REQUEUE ', url, '(no done job in SLP)'); continue;
      }

      const job = await httpGet(`/jobs/${done.id}`);
      const receipt = job.receipt ?? (job.receipt_json ? JSON.parse(job.receipt_json) : {}) ?? {};
      const dl = job.downloads || {};
      const h16 = createHash('sha256').update(url).digest('hex').slice(0, 16);

      let savedPdf = null, savedMd = null, mdContent = '';
      try { const buf = await httpGet(dl.pdf || `/jobs/${done.id}/pdf`, 'buffer'); savedPdf = join(UPGRADED, `x${h16}.pdf`); if (!DRY) writeFileSync(savedPdf, buf); } catch {}
      try { const md = await httpGet(dl.md || `/jobs/${done.id}/md`, 'text'); if (md?.trim()) { mdContent = md; savedMd = join(UPGRADED, `x${h16}.md`); if (!DRY) writeFileSync(savedMd, md); } } catch {}

      const m = receipt.metadata || {};
      const mdBody = mdContent.replace(/^---[\s\S]*?---\n?/, '').replace(/\{pdf=\d+\}/g, '').trim();
      const pageCount = receipt.document?.page_count ?? 1;
      const missing = [];
      if (!savedMd) missing.push('no_markdown');
      else if (mdBody.length < 300 && pageCount > 2) missing.push('empty_markdown');
      if (!m.title)   missing.push('no_title');
      if (!m.subject) missing.push('no_summary');

      if (missing.length) {
        if (!DRY) await httpPost(`/jobs/${done.id}/ack`, { validated: false, reason: missing.join(', ') }).catch(() => {});
        stats.still_failed++; log('FAIL    ', url, `[${missing.join(', ')}]`); continue;
      }

      const afterScore  = receipt.quality?.after  ?? null;
      const beforeScore = receipt.quality?.before ?? null;
      const gain        = receipt.quality?.gain   ?? (afterScore != null && beforeScore != null ? afterScore - beforeScore : null);
      const lang        = receipt.document?.language ?? null;

      if (!DRY) {
        db.prepare(`UPDATE pdf_upgrade_queue SET status='done', finished_at=?, error=NULL, upgraded_pdf_path=?, marker_md_path=?, before_score=COALESCE(before_score,?), after_score=?, score_improvement=?, pages_processed=?, method=?, receipt_json=?, pipeline_job_id=NULL WHERE url=?`)
          .run(new Date().toISOString(), savedPdf, savedMd, beforeScore, afterScore, gain, receipt.document?.page_count ?? null, 'pipeline-v2-recovered', JSON.stringify(receipt), url);

        const cols = [], vals = [];
        if (m.title)      { cols.push('ai_title=?');    vals.push(stripQuotes(m.title)); }
        if (m.title_en)   { cols.push('title_en=?');    vals.push(stripQuotes(m.title_en)); }
        if (m.subject_en || m.desc_en) { cols.push('desc_en=?'); vals.push(stripQuotes(m.subject_en || m.desc_en)); }
        const author = m.author && !LANG_NAMES.has((m.author || '').toLowerCase().trim()) && m.author.toLowerCase() !== 'unknown' ? m.author : null;
        if (author)       { cols.push('ai_author=?');   vals.push(author); }
        if (m.subject)    { cols.push('ai_summary=?');  vals.push(stripQuotes(m.subject)); }
        if (lang)         { cols.push('ai_language=?'); vals.push(lang); }
        if (cols.length)  { vals.push(url); db.prepare(`UPDATE pdf_quality SET ${cols.join(', ')} WHERE url=?`).run(...vals); }

        await httpPost(`/jobs/${done.id}/ack`, { validated: true }).catch(e => log('  ack failed:', e.message));
      }
      stats.recovered++; log('OK      ', url, '→', stripQuotes(m.title_en || m.title));
    } catch (e) { stats.errors++; log('ERROR   ', url, e.message); }
  }

  db.close();
  log('\n' + JSON.stringify(stats, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
