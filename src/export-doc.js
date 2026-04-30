// Document (PDF) export -- text extraction, rasterization, OCR pipeline, paragraph backlinks.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { mdDir, metaDir } from './config.js';
import { upsertExport, getOcrPage } from './db.js';
import { runAllEngines } from './ocr/engines.js';
import { reconcilePage, computeAgreement } from './ocr/reconcile.js';
import { compileRules, applyOcrOverride } from './rules.js';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Build YAML frontmatter block. */
const buildFrontmatter = (obj) => {
  const yaml = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n');
  return `---\n${yaml}\n---\n\n`;
};
/** Append backlink to paragraph text per config. */
const addBacklink = (text, sourceUrl, pageNo, paraNo, format, granularity) => {
  if (granularity === 'page') return text; // page-level headers added separately
  const visibleLink = ` [↗ p.${pageNo}](${sourceUrl}#page=${pageNo})`;
  const commentLink = `\n<!-- src: {"url":"${sourceUrl}","page":${pageNo},"para":${paraNo}} -->`;
  if (format === 'visible') return text + visibleLink;
  if (format === 'comment') return text + commentLink;
  return text + visibleLink + commentLink;
};
/** Try to parse PDF with pdf-parse. Returns { text, numpages } or null. */
const tryPdfParse = async (buf) => {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buf);
    return { text: data.text, numpages: data.numpages };
  } catch { return null; }
};
/** Rasterize PDF pages to PNGs using pdfjs-dist. Returns array of png paths. */
const rasterizePdf = async (buf, docHash, domain) => {
  const rasterDir = join(metaDir(domain), 'raster', docHash);
  mkdirSync(rasterDir, { recursive: true });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buf) });
  const pdf = await loadingTask.promise;
  const pngPaths = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pngPath = join(rasterDir, `page-${String(i).padStart(3, '0')}.png`);
    pngPaths.push(pngPath);
    if (existsSync(pngPath)) continue; // use cache
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    // pdfjs-dist in Node requires canvas -- use node-canvas if available, else skip
    try {
      const { createCanvas } = await import('canvas');
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      writeFileSync(pngPath, canvas.toBuffer('image/png'));
    } catch { writeFileSync(pngPath, Buffer.alloc(0)); } // placeholder if canvas unavailable
  }
  return { pngPaths, numPages: pdf.numPages };
};
/** Build page-level header for page granularity. */
const pageHeader = (sourceUrl, pageNo) => `## Page ${pageNo} [↗](${sourceUrl}#page=${pageNo})\n\n`;
/** Assemble full MD from per-page reconcile results. */
const assembleDocMd = (pageResults, sourceUrl, backlinkFormat, backlinkGranularity) => {
  return pageResults.map(({ pageNo, text_md }) => {
    const paragraphs = text_md.split(/\n{2,}/);
    if (backlinkGranularity === 'page') {
      return pageHeader(sourceUrl, pageNo) + paragraphs.join('\n\n');
    }
    return paragraphs.map((p, idx) => p.trim() ? addBacklink(p, sourceUrl, pageNo, idx + 1, backlinkFormat, backlinkGranularity) : p).join('\n\n');
  }).join('\n\n');
};
/**
 * Run document (PDF) export for a single document URL.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @param {object} page - DB page row
 */
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
  // Try text extraction first
  const pdfData = await tryPdfParse(buf);
  let pageResults = [];
  let ocrUsed = false;
  let ocrEnginesUsed = [];
  let reconcilerUsed = null;
  let totalPages = 1;
  let agreementScores = [];
  let flaggedPages = [];
  if (pdfData && pdfData.text && pdfData.text.length / (pdfData.numpages || 1) >= minCharsPerPage) {
    // Text PDF -- split by page markers
    totalPages = pdfData.numpages;
    const pageTexts = pdfData.text.split(/\f/).filter(t => t.trim());
    for (let i = 0; i < totalPages; i++) {
      pageResults.push({ pageNo: i + 1, text_md: pageTexts[i] || '' });
    }
  } else {
    // Image PDF -- rasterize and OCR
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
  // Cross-link: find host page for this doc
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
 * Run document export stage for all PDF pages in site.
 * @param {object} db - Site SQLite db
 * @param {object} siteConfig - Merged site config
 * @returns {object} Stats: { written, skipped, failed, ocr_pages, flagged }
 */
export const runExportDoc = async (db, siteConfig) => {
  const stats = { written: 0, skipped: 0, failed: 0, ocr_pages: 0, flagged: 0 };
  const pages = db.prepare("SELECT p.*, e.source_hash as exp_hash FROM pages p LEFT JOIN exports e ON p.url=e.url WHERE p.gone=0 AND p.mime_type='application/pdf' AND p.local_path IS NOT NULL").all();
  for (const page of pages) {
    if (!existsSync(page.local_path)) { stats.failed++; continue; }
    if (page.exp_hash && page.exp_hash === page.content_hash) { stats.skipped++; continue; }
    try {
      const result = await exportDoc(db, siteConfig, page);
      upsertExport(db, { url: page.url, md_path: result.mdPath, source_hash: page.content_hash, md_hash: null, exported_at: new Date().toISOString(), conversion_method: result.ocrUsed ? 'ocr' : 'pdf-text', word_count: null, ocr_used: result.ocrUsed ? 1 : 0, ocr_engines: result.ocrEnginesUsed?.join(',') || null, reconciler: result.reconcilerUsed, pages: result.totalPages, agreement_avg: result.agreementAvg, flagged_pages: result.flaggedPages?.join(',') || null, host_page_url: null, status: 'ok', error: null });
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
