// PDF export: text extraction, rasterization, OCR pipeline, MD output. Exports: exportTextPdf, runExportDoc. Re-exports: addBacklink, assembleDocMd. Deps: export-doc-utils, db, ocr/engines, ocr/reconcile, rules, pdf-upgrade/score
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { mdDir, metaDir } from './config.js';
import { upsertExport, getOcrPage } from './db.js';
import { runAllEngines } from './ocr/engines.js';
import { reconcilePage, computeAgreement } from './ocr/reconcile.js';
import { compileRules, applyOcrOverride } from './rules.js';
import { scorePdf, saveQualityScore, maybeQueue } from './pdf-upgrade/score.js';
export { addBacklink, assembleDocMd } from './export-doc-utils.js';
import { addBacklink, assembleDocMd } from './export-doc-utils.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const OCR_TIMEOUT_MS = 30000;
const RASTER_TIMEOUT_MS = 60000;
const PAGE_RENDER_TIMEOUT_MS = 30000;

const buildFrontmatter = (obj) => {
  const yaml = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
  return `---\n${yaml}\n---\n\n`;
};

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, r) => setTimeout(() => r(new Error(`${label} timed out after ${ms}ms`)), ms))]);

const tryPdfParse = async (buf) => {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await withTimeout(pdfParse(buf), OCR_TIMEOUT_MS, 'pdf-parse');
    return { text: data.text, numpages: data.numpages };
  } catch { return null; }
};

const rasterizePdf = async (buf, docHash, domain) => {
  const rasterDir = join(metaDir(domain), 'raster', docHash);
  mkdirSync(rasterDir, { recursive: true });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buf) });
  const pdf = await withTimeout(loadingTask.promise, RASTER_TIMEOUT_MS, 'pdfjs.getDocument');
  const pngPaths = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pngPath = join(rasterDir, `page-${String(i).padStart(3, '0')}.png`);
    pngPaths.push(pngPath);
    if (existsSync(pngPath)) continue;
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    try {
      const { createCanvas } = await import('canvas');
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await withTimeout(page.render({ canvasContext: ctx, viewport }).promise, PAGE_RENDER_TIMEOUT_MS, 'page.render');
      writeFileSync(pngPath, canvas.toBuffer('image/png'));
    } catch { writeFileSync(pngPath, Buffer.alloc(0)); }
  }
  return { pngPaths, numPages: pdf.numPages };
};

const exportDoc = async (db, siteConfig, page) => {
  const domain = siteConfig.domain;
  const ocrCfg = siteConfig.ocr || {};
  const docCfg = siteConfig.document || {};
  const backlinkFormat = docCfg.backlink_format || 'both';
  const backlinkGranularity = docCfg.backlink_granularity || 'paragraph';
  const llmProviders = siteConfig.llm?.providers || {};
  const compiled = compileRules(siteConfig.rules);
  const ocrOverride = applyOcrOverride(compiled, page.url);
  const engines = ocrOverride?.engines || ocrCfg.engines || ['mistral', 'claude'];
  const minCharsPerPage = ocrCfg.min_text_chars_per_page ?? 50;
  const buf = readFileSync(page.local_path);
  const docHash = sha256(buf);
  const pdfData = await tryPdfParse(buf);
  let pageResults = [];
  let ocrUsed = false;
  let ocrEnginesUsed = [];
  let reconcilerUsed = null;
  let totalPages = 1;
  let agreementScores = [];
  let flaggedPages = [];
  if (pdfData && pdfData.text && pdfData.text.length / (pdfData.numpages || 1) >= minCharsPerPage) {
    totalPages = pdfData.numpages;
    const pageTexts = pdfData.text.split(/\f/).filter(t => t.trim());
    for (let i = 0; i < totalPages; i++) pageResults.push({ pageNo: i + 1, text_md: pageTexts[i] || '' });
  } else {
    ocrUsed = true;
    ocrEnginesUsed = engines;
    const { pngPaths, numPages } = await rasterizePdf(buf, docHash, domain);
    totalPages = numPages;
    for (let i = 0; i < numPages; i++) {
      const pageNo = i + 1;
      const pngPath = pngPaths[i];
      const engineResults = await runAllEngines(db, page.url, pageNo, pngPath, engines, llmProviders);
      const { text_md, agreement_score, conversion_method, unresolved_spans } = await reconcilePage(db, page.url, pageNo, pngPath, engineResults, { ...ocrCfg, ...(ocrOverride || {}) }, llmProviders);
      if (conversion_method.includes('reconcile')) reconcilerUsed = ocrCfg.reconciler || 'claude';
      agreementScores.push(agreement_score);
      if (agreement_score < (ocrCfg.flag_threshold ?? 0.85)) flaggedPages.push(pageNo);
      pageResults.push({ pageNo, text_md });
    }
  }
  const docMd = assembleDocMd(pageResults, page.url, backlinkFormat, backlinkGranularity);
  const hostRow = db.prepare('SELECT h.*, e.md_path FROM hosts h LEFT JOIN exports e ON h.host_url=e.url WHERE h.hosted_url=?').get(page.url);
  const agreementAvg = agreementScores.length ? agreementScores.reduce((a, b) => a + b, 0) / agreementScores.length : null;
  const frontmatter = {
    source_url: page.url,
    backup_url: page.backup_url || null,
    backup_archived_at: page.backup_archived_at || null,
    domain,
    title: page.url.split('/').pop().replace(/\.\w+$/, ''),
    fetched_at: page.last_seen_at,
    content_hash: page.content_hash,
    mime_type: page.mime_type,
    mirror_path: page.local_path,
    url_path: new URL(page.url).pathname,
    page_role: 'document',
    ocr_used: ocrUsed,
    ocr_engines: ocrEnginesUsed.length ? JSON.stringify(ocrEnginesUsed) : null,
    reconciler: reconcilerUsed,
    pages: totalPages,
    agreement_avg: agreementAvg,
    flagged_pages: flaggedPages.length ? JSON.stringify(flaggedPages) : null,
    host_page_url: hostRow?.host_url || null,
    host_page_backup_url: hostRow?.backup_url || null,
    host_page_title: hostRow?.hosted_title || null,
    host_page_md: hostRow?.md_path || null,
    backlink_format: backlinkFormat,
    backlink_granularity: backlinkGranularity
  };
  const outDir = mdDir(domain);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `${page.path_slug}.md`);
  const fullMd = buildFrontmatter(frontmatter) + docMd;
  writeFileSync(mdPath, fullMd, 'utf8');
  return { mdPath, totalPages, ocrUsed, ocrEnginesUsed, reconcilerUsed, agreementAvg, flaggedPages };
};

/**
 * Export a text-layer PDF to MD immediately (no OCR). Skips if already exported at same hash.
 * Used inline during mirror and after PDF upgrade.
 */
export const exportTextPdf = async (db, siteConfig, page) => {
  const domain = siteConfig.domain;
  const ocrCfg = siteConfig.ocr || {};
  const docCfg = siteConfig.document || {};
  const minCharsPerPage = ocrCfg.min_text_chars_per_page ?? 50;
  const backlinkFormat = docCfg.backlink_format || 'both';
  const backlinkGranularity = docCfg.backlink_granularity || 'paragraph';
  if (!existsSync(page.local_path)) return false;
  const existing = db.prepare('SELECT source_hash FROM exports WHERE url=?').get(page.url);
  if (existing?.source_hash === page.content_hash) return false;
  let buf;
  try { buf = readFileSync(page.local_path); } catch { return false; }
  const pdfData = await tryPdfParse(buf);
  if (!pdfData || pdfData.text.length / (pdfData.numpages || 1) < minCharsPerPage) return false;
  const totalPages = pdfData.numpages;
  const pageTexts = pdfData.text.split(/\f/).filter(t => t.trim());
  const pageResults = [];
  for (let i = 0; i < totalPages; i++) pageResults.push({ pageNo: i + 1, text_md: pageTexts[i] || '' });
  const docMd = assembleDocMd(pageResults, page.url, backlinkFormat, backlinkGranularity);
  const hostRow = db.prepare('SELECT h.*, e.md_path FROM hosts h LEFT JOIN exports e ON h.host_url=e.url WHERE h.hosted_url=?').get(page.url);
  const frontmatter = {
    source_url: page.url, backup_url: page.backup_url || null, domain,
    title: page.url.split('/').pop().replace(/\.\w+$/, ''),
    fetched_at: page.last_seen_at, content_hash: page.content_hash,
    mime_type: page.mime_type, mirror_path: page.local_path,
    url_path: new URL(page.url).pathname, page_role: 'document',
    ocr_used: false, pages: totalPages,
    host_page_url: hostRow?.host_url || null, host_page_md: hostRow?.md_path || null,
    backlink_format: backlinkFormat, backlink_granularity: backlinkGranularity
  };
  const outDir = mdDir(domain);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `${page.path_slug}.md`);
  const fullMd = buildFrontmatter(frontmatter) + docMd;
  writeFileSync(mdPath, fullMd, 'utf8');
  upsertExport(db, {
    url: page.url, md_path: mdPath, source_hash: page.content_hash,
    md_hash: `sha256:${sha256(Buffer.from(fullMd))}`, exported_at: new Date().toISOString(),
    conversion_method: 'pdf-text', word_count: fullMd.split(/\s+/).filter(Boolean).length,
    ocr_used: 0, ocr_engines: null, reconciler: null, pages: totalPages,
    agreement_avg: null, flagged_pages: null, host_page_url: hostRow?.host_url || null,
    status: 'ok', error: null
  });
  return true;
};

/** Run document export for all PDF pages in site. */
export const runExportDoc = async (db, siteConfig) => {
  const stats = { written: 0, skipped: 0, failed: 0, ocr_pages: 0, flagged: 0 };
  const pages = db.prepare("SELECT p.*, e.source_hash as exp_hash FROM pages p LEFT JOIN exports e ON p.url=e.url WHERE p.gone=0 AND p.mime_type='application/pdf' AND p.local_path IS NOT NULL").all();
  for (const page of pages) {
    if (!existsSync(page.local_path)) { stats.failed++; continue; }
    if (page.exp_hash && page.exp_hash === page.content_hash) { stats.skipped++; continue; }
    try {
      const result = await exportDoc(db, siteConfig, page);
      upsertExport(db, { url: page.url, md_path: result.mdPath, source_hash: page.content_hash, md_hash: null, exported_at: new Date().toISOString(), conversion_method: result.ocrUsed ? 'ocr' : 'pdf-text', word_count: null, ocr_used: result.ocrUsed ? 1 : 0, ocr_engines: result.ocrEnginesUsed?.join(',') || null, reconciler: result.reconcilerUsed, pages: result.totalPages, agreement_avg: result.agreementAvg, flagged_pages: result.flaggedPages?.join(',') || null, host_page_url: null, status: 'ok', error: null });
      const qualityMetrics = await withTimeout(scorePdf(page.local_path), OCR_TIMEOUT_MS, 'scorePdf');
      saveQualityScore(db, page.url, page.content_hash, qualityMetrics);
      const upgradeThreshold = siteConfig.pdf_upgrade?.score_threshold ?? 0.7;
      maybeQueue(db, page.url, page.content_hash, qualityMetrics.composite_score, upgradeThreshold, qualityMetrics.language);
      stats.written++;
      if (result.ocrUsed) stats.ocr_pages += result.totalPages;
      stats.flagged += result.flaggedPages?.length || 0;
    } catch (err) {
      console.error(`[export-doc] ${page.url}: ${err.message}`);
      upsertExport(db, { url: page.url, md_path: null, source_hash: page.content_hash, md_hash: null, exported_at: new Date().toISOString(), conversion_method: null, word_count: null, ocr_used: 0, ocr_engines: null, reconciler: null, pages: null, agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'failed', error: err.message });
      stats.failed++;
    }
  }
  return stats;
};
