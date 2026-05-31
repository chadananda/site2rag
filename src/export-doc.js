// PDF/DOCX export: text layer extraction to MD, queue image PDFs for upgrade. No OCR.
// Exports: exportTextPdf, exportDocx, runExportDoc. Re-exports: addBacklink, assembleDocMd.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { mdDir } from './config.js';
import { upsertExport } from './db.js';
import { compileRules } from './rules.js';
import { scorePdf, saveQualityScore, maybeQueue } from './score.js';
export { addBacklink, assembleDocMd } from './export-doc-utils.js';
import { addBacklink, assembleDocMd } from './export-doc-utils.js';
import { wordQuality, detectLanguage } from './score.js';
import { detectLanguageFromUrl } from './language.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const PDF_PARSE_TIMEOUT_MS = 30_000;

export const buildFrontmatter = (obj) => {
  const yaml = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
  return `---\n${yaml}\n---\n\n`;
};

export const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, r) => setTimeout(() => r(new Error(`${label} timed out after ${ms}ms`)), ms))]);

/** Extract text layer from PDF buffer. Returns { text, numpages } or null if no usable text. */
const tryPdfParse = async (buf) => {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await withTimeout(pdfParse(buf), PDF_PARSE_TIMEOUT_MS, 'pdf-parse');
    return { text: data.text, numpages: data.numpages };
  } catch { return null; }
};

/**
 * Export a PDF to MD using text layer only. Skips if already exported at same hash.
 * Returns true if written, false if skipped or insufficient text.
 */
export const exportTextPdf = async (db, siteConfig, page) => {
  const domain = siteConfig.domain;
  const ocrCfg = siteConfig.ocr || {};
  const docCfg = siteConfig.document || {};
  const minCharsPerPage = ocrCfg.min_text_chars_per_page ?? 50;
  const backlinkFormat = docCfg.backlink_format || 'both';
  const backlinkGranularity = docCfg.backlink_granularity || 'paragraph';
  if (!existsSync(page.local_path)) return false;
  const existing = db.prepare('SELECT source_hash, conversion_method FROM exports WHERE url=?').get(page.url);
  const reprocessMethods = ['stub', 'pdf-text-garbled', 'pdf-text-sparse'];
  if (existing?.source_hash === page.content_hash && !reprocessMethods.includes(existing?.conversion_method)) return false;
  let buf;
  try { buf = readFileSync(page.local_path); } catch { return false; }
  const pdfData = await tryPdfParse(buf);
  if (!pdfData) return false;
  const charsPerPage = pdfData.text.length / (pdfData.numpages || 1);
  const lowTextDensity = charsPerPage < minCharsPerPage;
  // Language-aware quality: use URL language hint first, then detect from text
  const lang = detectLanguageFromUrl(page.url) || detectLanguage(pdfData.text.slice(0, 2000));
  const wq = wordQuality(pdfData.text.slice(0, 5000), lang);
  const lowTextQuality = wq < 0.8;
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
    low_text_density: lowTextDensity || undefined,
    low_text_quality: lowTextQuality || undefined,
    word_quality_estimate: Math.round(wq * 100) / 100,
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
    conversion_method: lowTextDensity ? 'pdf-text-sparse' : lowTextQuality ? 'pdf-text-garbled' : 'pdf-text', word_count: fullMd.split(/\s+/).filter(Boolean).length,
    ocr_used: 0, ocr_engines: null, reconciler: null, pages: totalPages,
    agreement_avg: null, flagged_pages: null, host_page_url: hostRow?.host_url || null,
    status: 'ok', error: null
  });
  return true;
};

/** Export a DOCX file to markdown via mammoth → turndown. */
export const exportDocx = async (db, siteConfig, page) => {
  const domain = siteConfig.domain;
  const mammoth = (await import('mammoth')).default;
  const TurndownService = (await import('turndown')).default;
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  const { value: html, messages } = await mammoth.convertToHtml({ path: page.local_path });
  if (messages.some(m => m.type === 'error'))
    console.warn(`[export-docx] warnings for ${page.url}:`, messages.filter(m => m.type === 'error').map(m => m.message).join('; '));
  const md = td.turndown(html);
  const frontmatter = buildFrontmatter({
    source_url: page.url, domain,
    title: page.url.split('/').pop().replace(/\.\w+$/, ''),
    fetched_at: page.last_seen_at, content_hash: page.content_hash,
    mime_type: page.mime_type, mirror_path: page.local_path,
    url_path: new URL(page.url).pathname, page_role: 'document',
    conversion_method: 'docx-mammoth',
  });
  const outDir = mdDir(domain);
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `${page.path_slug}.md`);
  const fullMd = frontmatter + md;
  writeFileSync(mdPath, fullMd, 'utf8');
  upsertExport(db, {
    url: page.url, md_path: mdPath, source_hash: page.content_hash,
    md_hash: `sha256:${sha256(Buffer.from(fullMd))}`, exported_at: new Date().toISOString(),
    conversion_method: 'docx-mammoth', word_count: md.split(/\s+/).filter(Boolean).length,
    ocr_used: 0, ocr_engines: null, reconciler: null, pages: null,
    agreement_avg: null, flagged_pages: null, host_page_url: null,
    status: 'ok', error: null,
  });
};

/** Export all PDF and DOCX pages for a site. PDFs get text-layer extraction; image PDFs get a stub + upgrade queue entry. */
export const runExportDoc = async (db, siteConfig) => {
  const stats = { written: 0, skipped: 0, failed: 0, queued: 0 };
  const compiled = compileRules(siteConfig.rules);
  if (compiled.prefer_format === 'html') return stats;

  // DOCX — mammoth conversion, no OCR
  const docxPages = db.prepare("SELECT p.*, e.source_hash as exp_hash FROM pages p LEFT JOIN exports e ON p.url=e.url WHERE p.gone=0 AND p.mime_type LIKE '%wordprocessingml%' AND p.local_path IS NOT NULL").all();
  for (const page of docxPages) {
    if (!existsSync(page.local_path)) { stats.failed++; continue; }
    if (page.exp_hash && page.exp_hash === page.content_hash) { stats.skipped++; continue; }
    try { await exportDocx(db, siteConfig, page); stats.written++; }
    catch (err) {
      console.error(`[export-docx] ${page.url}: ${err.message}`);
      upsertExport(db, { url: page.url, md_path: null, source_hash: page.content_hash, md_hash: null,
        exported_at: new Date().toISOString(), conversion_method: null, word_count: null,
        ocr_used: 0, ocr_engines: null, reconciler: null, pages: null,
        agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'failed', error: err.message });
      stats.failed++;
    }
  }

  // PDFs — text layer extraction only; image PDFs get stub MD and are queued for upgrade
  const pdfPages = db.prepare("SELECT p.*, e.source_hash as exp_hash, e.conversion_method as exp_method FROM pages p LEFT JOIN exports e ON p.url=e.url WHERE p.gone=0 AND p.mime_type='application/pdf' AND p.local_path IS NOT NULL").all();
  const upgradeThreshold = siteConfig.pdf_upgrade?.score_threshold ?? 0.7;

  for (const page of pdfPages) {
    if (!existsSync(page.local_path)) { stats.failed++; continue; }
    // Reject non-PDF files (HTML error pages saved as .pdf, empty stubs, etc.)
    try {
      const header = readFileSync(page.local_path).slice(0, 5).toString('ascii');
      if (header !== '%PDF-') { db.prepare("UPDATE pages SET gone=1 WHERE url=?").run(page.url); stats.failed++; continue; }
    } catch { stats.failed++; continue; }
    // Skip if already exported at same hash, UNLESS it was low-quality (re-attempt after OCR)
    const reprocessMethods = ['stub', 'pdf-text-garbled', 'pdf-text-sparse'];
    if (page.exp_hash && page.exp_hash === page.content_hash && !reprocessMethods.includes(page.exp_method)) { stats.skipped++; continue; }
    try {
      const buf = readFileSync(page.local_path);
      let qualityMetrics;
      try { qualityMetrics = await withTimeout(scorePdf(page.local_path), PDF_PARSE_TIMEOUT_MS, 'scorePdf'); } catch { qualityMetrics = null; }
      if (qualityMetrics) saveQualityScore(db, page.url, page.content_hash, qualityMetrics);

      const wrote = await exportTextPdf(db, siteConfig, page);
      if (wrote) {
        stats.written++;
      } else {
        // Image PDF or insufficient text — write stub frontmatter so the URL is tracked
        const domain = siteConfig.domain;
        const outDir = mdDir(domain);
        mkdirSync(outDir, { recursive: true });
        const mdPath = join(outDir, `${page.path_slug}.md`);
        const stub = buildFrontmatter({
          source_url: page.url, domain,
          title: page.url.split('/').pop().replace(/\.\w+$/, ''),
          fetched_at: page.last_seen_at, content_hash: page.content_hash,
          mime_type: page.mime_type, mirror_path: page.local_path,
          url_path: new URL(page.url).pathname, page_role: 'document',
          ocr_used: false, upgrade_pending: true,
        });
        writeFileSync(mdPath, stub, 'utf8');
        upsertExport(db, {
          url: page.url, md_path: mdPath, source_hash: page.content_hash,
          md_hash: `sha256:${sha256(Buffer.from(stub))}`, exported_at: new Date().toISOString(),
          conversion_method: 'stub', word_count: 0,
          ocr_used: 0, ocr_engines: null, reconciler: null, pages: qualityMetrics?.pages ?? null,
          agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'ok', error: null
        });
        stats.written++;
      }

      // Queue for upgrade regardless of text quality — upgrade produces superior PDF + MD
      if (qualityMetrics) {
        maybeQueue(db, page.url, page.content_hash, qualityMetrics.composite_score, upgradeThreshold, qualityMetrics.language);
        stats.queued++;
      }
    } catch (err) {
      console.error(`[export-doc] ${page.url}: ${err.message}`);
      upsertExport(db, { url: page.url, md_path: null, source_hash: page.content_hash, md_hash: null,
        exported_at: new Date().toISOString(), conversion_method: null, word_count: null,
        ocr_used: 0, ocr_engines: null, reconciler: null, pages: null,
        agreement_avg: null, flagged_pages: null, host_page_url: null, status: 'failed', error: err.message });
      stats.failed++;
    }
  }
  return stats;
};
