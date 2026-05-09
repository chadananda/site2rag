// PDF quality scoring -- heuristics only, no AI. Exports: scorePdf, saveQualityScore, maybeQueue, extractBadSample. Re-exports: detectLanguage, LANG_COST, LANG_PRIORITY. Deps: pdf-parse, language
import pdfParse from 'pdf-parse';
import { readFileSync } from 'fs';
import { detectLanguage, detectLanguageFromUrl, LANG_COST, LANG_PRIORITY, LANG_WORDS } from '../language.js';
export { detectLanguage, LANG_COST, LANG_PRIORITY };
// Common English function words for word quality estimation (baseline when lang unknown)
const COMMON_WORDS = new Set(['the','of','and','to','a','in','is','it','you','that','he','was','for','on','are','as','with','his','they','at','be','this','from','or','had','by','not','but','have','an','were','we','their','one','all','would','there','what','so','up','out','if','about','who','get','which','go','me','when','make','can','like','time','no','just','him','know','take','into','year','your','good','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','first','well','way','even','new','want','because','any','these','give','day','most','us']);
/** Estimate word quality from a text sample. Returns 0-1. lang param selects word set. */
export const wordQuality = (text, lang = 'english') => {
  if (!text || !text.trim()) return 0;
  const tokens = text.replace(/[^a-zA-ZÀ-ÿ\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 && w.length <= 20);
  if (tokens.length < 10) return 0;
  const sample = tokens.slice(0, 200);
  const wordSet = LANG_WORDS[lang] || COMMON_WORDS;
  const realWords = sample.filter(w => {
    const lower = w.toLowerCase();
    if (wordSet.has(lower)) return true;
    // Language-neutral vowel ratio heuristic (works for all European languages)
    const vowels = (lower.match(/[aeiouàáâãäåæçèéêëìíîïðñòóôõöùúûüý]/g) || []).length;
    const ratio = vowels / lower.length;
    // Garbled OCR tends to have extreme ratios (all consonants or gibberish)
    return ratio >= 0.2 && ratio <= 0.75 && !/(.)\1{3,}/.test(lower);
  });
  return realWords.length / sample.length;
};
/**
 * Score a PDF file for OCR quality. Returns quality metrics object.
 * @param {string} pdfPath - Path to PDF file
 * @returns {object} { avg_chars_per_page, readable_pages_pct, has_text_layer, word_quality_estimate, composite_score, pages }
 */
const SAMPLE_PAGES = 5; // parse only first N pages for speed

/** Extract first meaningful sentence(s) of text for display. */
export const extractExcerpt = (text, maxChars = 280) => {
  if (!text) return '';
  const clean = text.replace(/\f/g, ' ').replace(/\s+/g, ' ').trim();
  const match = clean.match(/[A-ZÀ-Ö][a-zA-ZÀ-ÿ,;:\s]{40,}/);
  return (match ? match[0] : clean).slice(0, maxChars).trim();
};

export const scorePdf = async (pdfPath) => {
  const empty = { avg_chars_per_page: 0, readable_pages_pct: 0, has_text_layer: 0, word_quality_estimate: 0, composite_score: 0, pages: 0, pdf_title: '', excerpt: '', language: 'unknown', processing_difficulty: 1.0 };
  try {
    const buf = readFileSync(pdfPath);
    // First pass: get page count + PDF metadata title
    // pdf-parse uses a singleton PDFJS module that fails on the very first parse call
    // (disableWorker not yet applied), so retry once on any error.
    let meta;
    try { meta = await pdfParse(buf, { max: 1 }); } catch { try { meta = await pdfParse(buf, { max: 1 }); } catch { return empty; } }
    const pages = meta.numpages || 1;
    const pdf_title = (meta.info?.Title || '').trim().slice(0, 200);
    // Second pass: sample up to SAMPLE_PAGES pages for quality heuristics
    const sampleMax = Math.min(pages, SAMPLE_PAGES);
    let data;
    try { data = await pdfParse(buf, { max: sampleMax }); } catch { return empty; }
    const sampleText = data.text || '';
    const pageTexts = sampleText.split('\f');
    const readableInSample = pageTexts.filter(p => p.replace(/\s/g, '').length >= 50).length;
    const readablePct = sampleMax > 0 ? readableInSample / sampleMax : 0;
    const avgChars = sampleText.length / sampleMax;
    const hasText = avgChars > 5 ? 1 : 0;
    // Detect language first so wordQuality uses the correct word set
    const langSample = [pdf_title, sampleText.slice(0, 2000)].join(' ');
    const language = detectLanguage(langSample);
    const wq = wordQuality(sampleText.slice(0, 5000), language);
    const charsScore = Math.min(avgChars / 500, 1);
    // pdf-parse cannot decode Persian/Arabic/CJK scripts → pages with non-Latin text appear empty,
    // making readablePct artificially low for text-layer PDFs. Use charsScore as a floor when
    // has_text_layer=1: high avg_chars proves content exists even if the script is undecodable.
    const adjustedReadable = hasText === 1 ? Math.max(readablePct, charsScore * 0.85) : readablePct;
    // wordQuality() strips non-Latin chars before checking word lists, so Persian/Arabic/CJK
    // text-layer PDFs always return wq=0 even when the text is perfect. Substitute 0.8 when
    // the script is non-Latin, the text layer exists, and there are substantial chars/page.
    const NON_LATIN = new Set(['persian','arabic','hebrew','hindi','chinese','japanese','korean']);
    const effectiveWq = (NON_LATIN.has(language) && wq === 0 && hasText === 1 && avgChars >= 100) ? 0.8 : wq;
    const composite = 0.4 * effectiveWq + 0.3 * adjustedReadable + 0.2 * charsScore + 0.1 * hasText;
    const excerpt = extractExcerpt(sampleText);
    // Processing difficulty: 0=trivial (text PDF, skip OCR), 1=hardest (dense image scan).
    // Primary driver: no text layer = needs OCR. Secondary: page count. Tertiary: script complexity.
    // Handwritten non-Latin scripts (Persian/Arabic image PDFs) are hardest → OCR nearly always fails.
    const scriptHard = ['persian','arabic','hebrew','hindi','chinese','japanese','korean'].includes(language);
    const processing_difficulty = hasText === 1
      ? 0.05                                                                   // text layer: skip OCR, trivially easy
      : pages === 0 ? 1.0                                                      // unreadable/failed: assume worst
      : Math.max(0.3, Math.min(1.0, (pages / 400) * (scriptHard ? 2.0 : 1.0))); // image PDF: min 0.3 (needs OCR)
    return { avg_chars_per_page: Math.round(avgChars), readable_pages_pct: Math.round(readablePct * 100) / 100, has_text_layer: hasText, word_quality_estimate: Math.round(effectiveWq * 100) / 100, composite_score: Math.round(composite * 100) / 100, pages, pdf_title, excerpt, language, processing_difficulty: Math.round(processing_difficulty * 100) / 100 };
  } catch { return empty; }
};
/** Extract a short sample of OCR text for display (shows quality problems). */
export const extractBadSample = (pdfPath, maxChars = 300) => {
  try {
    const buf = readFileSync(pdfPath);
    // Sync read first 50KB for speed
    const text = buf.toString('latin1').replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ').trim();
    // Find the first block that looks like OCR text (has some words)
    const match = text.match(/[A-Za-z]{3,}(?:\s+[A-Za-z]{2,}){4,}/);
    return match ? match[0].slice(0, maxChars) : text.slice(0, maxChars);
  } catch { return ''; }
};
/** Save quality score to DB for a document URL. */
export const saveQualityScore = (db, url, contentHash, metrics) => {
  try { db.exec('ALTER TABLE pdf_quality ADD COLUMN processing_difficulty REAL'); } catch {}
  // URL-based language detection overrides text-based: a filename in Arabic/Persian script
  // is definitive even when the PDF text layer is garbled or uses custom font encoding.
  const urlLang = detectLanguageFromUrl(url);
  const language = urlLang || metrics.language || null;
  // Garbled text-layer detection: has_text_layer=1 but near-zero word quality means the PDF
  // uses custom font encoding (common in Persian PDFs). The text layer is unreadable noise —
  // treat it as an image PDF for scoring purposes.
  let composite = metrics.composite_score;
  let hasText = metrics.has_text_layer;
  if (hasText === 1 && (metrics.word_quality_estimate ?? 0) < 0.05) {
    // Custom-encoded text layer — functionally equivalent to image PDF
    hasText = 0;
    composite = Math.min(composite, 0.15); // cap score so it stays in upgrade queue
  }
  db.prepare(`INSERT OR REPLACE INTO pdf_quality (url, content_hash, scored_at, avg_chars_per_page, readable_pages_pct, has_text_layer, word_quality_estimate, composite_score, pages, pdf_title, excerpt, ai_language, processing_difficulty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(url, contentHash, new Date().toISOString(), metrics.avg_chars_per_page, metrics.readable_pages_pct, hasText, metrics.word_quality_estimate, composite, metrics.pages, metrics.pdf_title || null, metrics.excerpt || null, language, metrics.processing_difficulty ?? null);
};
/** Queue a PDF for upgrade if below score threshold. Text-layer PDFs are top priority (fast pipeline pass). */
export const maybeQueue = (db, url, contentHash, score, threshold = 0.7, language = null, hasTextLayer = null) => {
  if (score >= threshold) return false;
  const existing = db.prepare('SELECT status FROM pdf_upgrade_queue WHERE url=?').get(url);
  if (existing && existing.status !== 'pending') return false; // already processed or in progress
  // Prefer the DB-stored language (corrected by detectLanguageForImagePdfs) over the
  // text-extraction guess — pdf-parse often detects Persian/Arabic as 'english' due to
  // sparse Latin metadata (title, publisher) outweighing undecodable script characters.
  const dbRow = db.prepare('SELECT ai_language, has_text_layer FROM pdf_quality WHERE url=?').get(url);
  const dbLang = dbRow?.ai_language;
  const textLayer = hasTextLayer ?? dbRow?.has_text_layer ?? 0;
  // URL percent-encoding is definitive for Arabic/Persian — overrides text-extracted guess
  const urlLang = detectLanguageFromUrl(url);
  const langKey = (urlLang || (dbLang && dbLang !== 'unknown' ? dbLang : language) || 'unknown').toLowerCase();
  const langMult = LANG_PRIORITY[langKey] ?? LANG_PRIORITY.unknown;
  // Text-layer PDFs go first: they process in seconds (pipeline skips OCR, just adds clean text layer).
  // Image PDFs are slower (full OCR). Non-English deeply deprioritized.
  const textBoost = textLayer ? 100 : 1;
  const priority = textBoost * (1 - score) * langMult;
  db.prepare(`INSERT OR REPLACE INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at)
    VALUES (?, ?, ?, 'pending', ?)`)
    .run(url, contentHash, priority, new Date().toISOString());
  return true;
};
