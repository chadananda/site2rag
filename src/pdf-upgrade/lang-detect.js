// Language detection pipeline for image PDFs: free Unicode scan → Tesseract+Haiku identify. Exports: detectLanguageForImagePdfs. Deps: score, identify, language, fs
import { existsSync, readFileSync } from 'fs';
import { cpus } from 'os';
import { detectLanguage, LANG_PRIORITY } from '../language.js';
import { identifyDocument } from './identify.js';

const log = (msg) => console.log(`[pdf-upgrade] ${new Date().toISOString().slice(0,19)} ${msg}`);
const FREE_BATCH = 200;
const IDENTIFY_BATCH = 40;
const URL_LANG_HINTS = {
  arabic:  /\/arabic\/|[_-]ar[_-]|\/ar\//,
  persian: /\/persian\/|\/farsi\/|[_-]fa[_-]|\/fa\//,
  hebrew:  /\/hebrew\/|[_-]he[_-]|\/he\//,
  japanese: /\/japanese\/|[_-]ja[_-]|\/ja\//,
  chinese: /\/chinese\/|[_-]zh[_-]|\/zh\//,
};

const saveAndReprioritize = (db, url, langKey, topic) => {
  db.prepare('UPDATE pdf_quality SET ai_language=? WHERE url=?').run(langKey, url);
  if (topic) {
    const existing = db.prepare('SELECT ai_summary FROM pdf_quality WHERE url=?').get(url);
    if (!existing?.ai_summary) db.prepare('UPDATE pdf_quality SET ai_summary=? WHERE url=?').run(topic, url);
  }
  const queueRow = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=? AND status='pending'").get(url);
  if (queueRow) {
    const score = db.prepare('SELECT composite_score FROM pdf_quality WHERE url=?').get(url)?.composite_score ?? 0.5;
    const mult = LANG_PRIORITY[langKey] ?? LANG_PRIORITY.unknown;
    db.prepare('UPDATE pdf_upgrade_queue SET priority=? WHERE url=?').run((1 - score) * mult, url);
  }
};

/**
 * Three-stage language detection for image PDFs. Mutates db: updates ai_language and reprioritizes.
 * Stage 1: free Unicode scan of anchor text, title, excerpt, host-page snippet
 * Stage 2: Tesseract+Haiku identify pipeline for remaining unknowns
 */
export const detectLanguageForImagePdfs = async (db, domain) => {
  // Stage 1 — free Unicode detection on all docs with unknown language
  const freeRows = db.prepare(`
    SELECT pq.url, pq.pdf_title, pq.excerpt,
           h.hosted_title, hp.local_path as host_local_path, p.local_path
    FROM pdf_quality pq
    LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON pq.url=h.hosted_url
    LEFT JOIN pages hp ON h.host_url=hp.url
    LEFT JOIN pages p ON pq.url=p.url
    WHERE (pq.ai_language IS NULL OR pq.ai_language='unknown')
    LIMIT ?`).all(FREE_BATCH);

  let freeDetected = 0;
  for (const row of freeRows) {
    let langKey = 'unknown';
    for (const [lang, re] of Object.entries(URL_LANG_HINTS)) {
      if (re.test(row.url)) { langKey = lang; break; }
    }
    if (langKey === 'unknown') {
      const titleSample = [row.hosted_title, row.pdf_title, row.excerpt].filter(Boolean).join(' ');
      langKey = detectLanguage(titleSample);
    }
    if (langKey === 'unknown' && row.host_local_path && existsSync(row.host_local_path)) {
      try {
        const html = readFileSync(row.host_local_path, 'utf8').slice(0, 80_000);
        const filename = row.url.split('/').pop();
        const idx = html.indexOf(filename);
        const snippet = idx >= 0 ? html.slice(Math.max(0, idx - 800), idx + 800) : html.slice(0, 4000);
        langKey = detectLanguage(snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      } catch {}
    }
    if (langKey && langKey !== 'unknown') {
      saveAndReprioritize(db, row.url, langKey, null);
      log(`Lang (free): ${row.url} → ${langKey}`);
      freeDetected++;
    } else {
      db.prepare('UPDATE pdf_quality SET ai_language=? WHERE url=?').run('unknown', row.url);
      saveAndReprioritize(db, row.url, 'unknown', null);
    }
  }
  if (freeDetected) log(`Lang free scan: ${freeDetected}/${freeRows.length} identified`);

  // Stage 2 — Tesseract+Haiku identify pipeline for image PDFs still unknown
  const identifyRows = db.prepare(`
    SELECT pq.url, pq.pdf_title, pq.excerpt,
           h.hosted_title, hp.local_path as host_local_path, p.local_path
    FROM pdf_quality pq
    JOIN pages p ON pq.url=p.url
    LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title FROM hosts GROUP BY hosted_url) h ON pq.url=h.hosted_url
    LEFT JOIN pages hp ON h.host_url=hp.url
    WHERE pq.ai_language='unknown'
      AND (pq.has_text_layer=0 OR pq.has_text_layer IS NULL)
      AND p.local_path IS NOT NULL
    ORDER BY COALESCE((SELECT priority FROM pdf_upgrade_queue WHERE url=pq.url), 0) DESC
    LIMIT ?`).all(IDENTIFY_BATCH);

  const concurrency = Math.max(4, Math.floor(cpus().length / 2));
  let identified = 0;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const queue = identifyRows.filter(r => existsSync(r.local_path));

  const runOne = async (row) => {
    try {
      let hostPageSnippet = '';
      if (row.host_local_path && existsSync(row.host_local_path)) {
        try {
          const html = readFileSync(row.host_local_path, 'utf8').slice(0, 80_000);
          const filename = row.url.split('/').pop();
          const idx = html.indexOf(filename);
          hostPageSnippet = idx >= 0
            ? html.slice(Math.max(0, idx - 400), idx + 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            : '';
        } catch {}
      }
      const metadata = { hostedTitle: row.hosted_title || null, pdfTitle: row.pdf_title || null, excerpt: row.excerpt || null, hostPageSnippet };
      const result = await identifyDocument(row.local_path, metadata, db, row.url, apiKey);
      if (result.langKey && result.langKey !== 'unknown') {
        saveAndReprioritize(db, row.url, result.langKey, result.summary);
        log(`Lang (${result.stage}): ${row.url} → ${result.langKey}${result.summary ? ' / ' + result.summary.slice(0, 60) : ''}`);
        identified++;
      } else {
        saveAndReprioritize(db, row.url, 'unknown', null);
      }
    } catch (e) {
      log(`Identify failed: ${row.url}: ${e.message}`);
    }
  };

  for (let i = 0; i < queue.length; i += concurrency) {
    await Promise.all(queue.slice(i, i + concurrency).map(runOne));
  }
  if (identifyRows.length) log(`Identify pipeline: ${identified}/${identifyRows.length} resolved (concurrency=${concurrency})`);
};
