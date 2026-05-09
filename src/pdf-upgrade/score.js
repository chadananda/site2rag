// PDF quality scoring -- heuristics only, no AI. Exports: scorePdf, saveQualityScore, maybeQueue, extractBadSample. Re-exports: detectLanguage, LANG_COST, LANG_PRIORITY. Deps: pdf-parse, language
import pdfParse from 'pdf-parse';
import { readFileSync } from 'fs';
import { detectLanguage, detectLanguageFromUrl, LANG_COST, LANG_PRIORITY, LANG_WORDS } from '../language.js';
export { detectLanguage, LANG_COST, LANG_PRIORITY };
// Common English function words for word quality estimation (baseline when lang unknown)
const COMMON_WORDS = new Set(['the','of','and','to','a','in','is','it','you','that','he','was','for','on','are','as','with','his','they','at','be','this','from','or','had','by','not','but','have','an','were','we','their','one','all','would','there','what','so','up','out','if','about','who','get','which','go','me','when','make','can','like','time','no','just','him','know','take','into','year','your','good','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','first','well','way','even','new','want','because','any','these','give','day','most','us']);

// Unicode ranges for non-Latin scripts: [lo, hi] codepoint pairs
const SCRIPT_RANGES = {
  persian: [[0x0600,0x06FF],[0x0750,0x077F],[0xFB50,0xFDFF],[0xFE70,0xFEFF]],
  arabic:  [[0x0600,0x06FF],[0x0750,0x077F],[0xFB50,0xFDFF],[0xFE70,0xFEFF]],
  hebrew:  [[0x0590,0x05FF],[0xFB1D,0xFB4F]],
  hindi:   [[0x0900,0x097F],[0xA8E0,0xA8FF]],
  chinese: [[0x4E00,0x9FFF],[0x3400,0x4DBF],[0x20000,0x2A6DF]],
  japanese:[[0x3040,0x30FF],[0x4E00,0x9FFF],[0xFF66,0xFF9F]],
  korean:  [[0xAC00,0xD7AF],[0x1100,0x11FF],[0x3130,0x318F]],
};

/**
 * Script consistency: fraction of non-whitespace chars in the expected Unicode block.
 * Returns 0-1, or null if lang has no defined ranges or sample is too small.
 * Real text in a script: 60-95%. OCR garbage: 5-30%.
 */
export const scriptConsistency = (text, lang) => {
  const ranges = SCRIPT_RANGES[lang];
  if (!ranges || !text) return null;
  const chars = [...text].filter(c => c.trim());
  if (chars.length < 20) return null;
  const inScript = chars.filter(c => {
    const cp = c.codePointAt(0);
    return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  });
  return inScript.length / chars.length;
};

/**
 * Token distribution quality: reasonable word lengths and variety.
 * Works for any script — does not require a word list.
 * Returns 0-1. Penalises OCR artefacts (all same length, extreme lengths, heavy repetition).
 */
const tokenDistribution = (text) => {
  const tokens = text.split(/\s+/).filter(w => w.length >= 2 && w.length <= 25);
  if (tokens.length < 5) return 0;
  const reasonable = tokens.filter(w => w.length >= 3 && w.length <= 15).length / tokens.length;
  const unique = new Set(tokens).size / Math.min(tokens.length, 100);
  return reasonable * 0.6 + unique * 0.4;
};

/** Estimate word quality from a text sample. Returns 0-1. lang param selects word set. */
export const wordQuality = (text, lang = 'english') => {
  if (!text || !text.trim()) return 0;
  // Non-Latin scripts: use Unicode script consistency + token distribution
  const sc = scriptConsistency(text, lang);
  if (sc !== null) {
    const td = tokenDistribution(text);
    // sc dominates: Latin OCR garbage on an Arabic scan has sc≈0, so td (which can be decent
    // for any varied token set) cannot rescue the score. Real text in the right script has sc≥0.6.
    return Math.round((sc * 0.85 + td * 0.15) * 100) / 100;
  }
  // Latin scripts: word-list + vowel-ratio heuristic
  const tokens = text.replace(/[^a-zA-ZÀ-ÿ\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 && w.length <= 20);
  if (tokens.length < 10) return 0;
  const sample = tokens.slice(0, 200);
  const wordSet = LANG_WORDS[lang] || COMMON_WORDS;
  const realWords = sample.filter(w => {
    const lower = w.toLowerCase();
    if (wordSet.has(lower)) return true;
    const vowels = (lower.match(/[aeiouàáâãäåæçèéêëìíîïðñòóôõöùúûüý]/g) || []).length;
    const ratio = vowels / lower.length;
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
    // wordQuality() now handles non-Latin scripts via scriptConsistency() — no substitution needed.
    const composite = 0.4 * wq + 0.3 * adjustedReadable + 0.2 * charsScore + 0.1 * hasText;
    const excerpt = extractExcerpt(sampleText);
    // Processing difficulty: 0=trivial (text PDF, skip OCR), 1=hardest (dense image scan).
    // Primary driver: no text layer = needs OCR. Secondary: page count. Tertiary: script complexity.
    // Handwritten non-Latin scripts (Persian/Arabic image PDFs) are hardest → OCR nearly always fails.
    const scriptHard = ['persian','arabic','hebrew','hindi','chinese','japanese','korean'].includes(language);
    const processing_difficulty = hasText === 1
      ? 0.05                                                                   // text layer: skip OCR, trivially easy
      : pages === 0 ? 1.0                                                      // unreadable/failed: assume worst
      : Math.max(0.3, Math.min(1.0, (pages / 400) * (scriptHard ? 2.0 : 1.0))); // image PDF: min 0.3 (needs OCR)
    return { avg_chars_per_page: Math.round(avgChars), readable_pages_pct: Math.round(readablePct * 100) / 100, has_text_layer: hasText, word_quality_estimate: Math.round(wq * 100) / 100, composite_score: Math.round(composite * 100) / 100, pages, pdf_title, excerpt, language, processing_difficulty: Math.round(processing_difficulty * 100) / 100 };
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
