// PDF quality scoring — heuristics only, no AI. Scores readability, text density, language.
// Exports: scorePdf, saveQualityScore, maybeQueue, wordQuality, extractBadSample, ocrNoiseRatio, isGarbledTextLayer, detectLanguage, LANG_COST, LANG_PRIORITY
// maybeQueue: inserts into pdf_upgrade_queue if composite_score < threshold (used by mirror + export-doc)
import pdfParse from 'pdf-parse';                                                  // text extraction from PDF
import { readFileSync, existsSync } from 'fs';
import { detectLanguage, detectLanguageFromUrl, LANG_COST, LANG_PRIORITY, LANG_WORDS } from './language.js'; // lang detection + cost tables
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
/**
 * Fraction of non-whitespace chars that are printable (>= U+0020).
 * Control chars 0x01-0x1F indicate custom-font-encoded PDFs where glyph IDs
 * were stored as char codes — the text layer exists but is encoding garbage.
 * Returns 0-1. Real text: > 0.95. Encoding garbage: < 0.5.
 */
export const printableRatio = (text) => {
  const nonWs = [...text].filter(c => /\S/.test(c));
  if (nonWs.length < 20) return 1;
  return nonWs.filter(c => c.codePointAt(0) >= 0x20).length / nonWs.length;
};

/**
 * Detect garbled text layers from legacy font encoding (legacy Persian/Arabic fonts, PUA slots).
 * Mirrors SLP's four-check heuristic. Any one trigger = garbled.
 * Key signal: Latin Extended (U+00C0–U+02FF) > 15% saturates in garbled output; real docs < 1%.
 */
export const isGarbledTextLayer = (text, lang = null) => {
  if (!text) return false;
  const nonWs = [...text].filter(c => /\S/.test(c));
  if (nonWs.length < 50) return false;

  // Latin Extended density — most reliable single signal for legacy Persian/Arabic font output
  const latinExt = nonWs.filter(c => { const cp = c.codePointAt(0); return cp >= 0x00C0 && cp <= 0x02FF; }).length;
  if (latinExt / nonWs.length > 0.15) return true;

  // Private Use Area — older Arabic fonts store glyph IDs in PUA slots
  const pua = nonWs.filter(c => { const cp = c.codePointAt(0); return cp >= 0xE000 && cp <= 0xF8FF; }).length;
  if (pua / nonWs.length > 0.05) return true;

  // RTL/ASCII mismatch — Arabic/Hebrew script present but mostly ASCII letters (BDavat, old Farsi fonts)
  const rtl = nonWs.filter(c => { const cp = c.codePointAt(0); return (cp >= 0x0590 && cp <= 0x05FF) || (cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0xFB50 && cp <= 0xFEFF); }).length;
  if (rtl > nonWs.length * 0.05) {
    const ascii = nonWs.filter(c => { const cp = c.codePointAt(0); return (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A); }).length;
    if (ascii / (rtl + ascii) > 0.25) return true;
  }

  // Script density — expected script chars < 50% of nonWs when lang is non-Latin
  if (lang && SCRIPT_RANGES[lang]) {
    const ranges = SCRIPT_RANGES[lang];
    const inScript = nonWs.filter(c => { const cp = c.codePointAt(0); return cp >= 0x20 && ranges.some(([lo, hi]) => cp >= lo && cp <= hi); }).length;
    if (inScript / nonWs.length < 0.50) return true;
  }

  return false;
};

export const scriptConsistency = (text, lang) => {
  const ranges = SCRIPT_RANGES[lang];
  if (!ranges || !text) return null;
  // Only count printable chars — control chars (0x00-0x1F) are encoding garbage, not script chars
  const chars = [...text].filter(c => c.trim() && c.codePointAt(0) >= 0x20);
  if (chars.length < 20) return null;
  const inScript = chars.filter(c => {
    const cp = c.codePointAt(0);
    return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  });
  return inScript.length / chars.length;
};

/**
 * Average number of in-script chars per token for word-forming scripts (Arabic/Persian/Hebrew).
 * Real Persian/Arabic words average 3.5-5 chars. Fragmented garbage (single isolated letters
 * mixed with ASCII) averages 1.2-1.8 chars. Returns null if lang has no script ranges.
 */
const scriptAvgTokenLen = (text, lang) => {
  const ranges = SCRIPT_RANGES[lang];
  if (!ranges) return null;
  const tokens = text.split(/\s+/);
  const scriptLens = [];
  for (const tok of tokens) {
    const inScript = [...tok].filter(c => {
      const cp = c.codePointAt(0);
      return cp >= 0x20 && ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
    });
    if (inScript.length >= 1) scriptLens.push(inScript.length);
  }
  if (scriptLens.length < 5) return null;
  return scriptLens.reduce((a, b) => a + b, 0) / scriptLens.length;
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

/**
 * OCR digit-substitution noise ratio for Latin-script text.
 * Detects confusable digit↔letter substitutions (0↔O, 1↔l, 5↔S, 8↔B, 2↔Z).
 * Real prose: ~0%. OCR scans: 5-20%.
 * Returns 0-1 (fraction of letter-dominant tokens with embedded digit in letter run).
 */
export const ocrNoiseRatio = (text) => {
  const tokens = text.split(/\s+/).filter(w => w.length >= 3 && w.length <= 25);
  const letterTokens = tokens.filter(w => {
    const letters = (w.match(/[a-zA-Z]/g) || []).length;
    return letters / w.length >= 0.5;
  });
  if (letterTokens.length < 10) return 0;
  const noisy = letterTokens.filter(w => /[a-zA-Z][0-9][a-zA-Z]/.test(w));
  return noisy.length / letterTokens.length;
};

/** Estimate word quality from a text sample. Returns 0-1. lang param selects word set. */
export const wordQuality = (text, lang = 'english') => {
  if (!text || !text.trim()) return 0;
  // Control-char check: custom-font-encoded PDFs store glyph IDs as char codes 0x01-0x1F.
  // printableRatio near 0 = encoding garbage regardless of what script chars are present.
  const pr = printableRatio(text);
  if (pr < 0.3) return Math.round(pr * 100) / 100; // mostly control chars = near-zero quality
  // Non-Latin scripts: use Unicode script consistency + token distribution
  const sc = scriptConsistency(text, lang);
  if (sc !== null) {
    const td = tokenDistribution(text);
    let scriptScore = Math.min(1, sc * 0.85 + td * 0.15);
    // Word-forming scripts (Arabic/Persian/Hebrew): real words are 3-7 chars of connected script.
    // Fragmented encoding garbage produces single isolated letters (avg 1.2-1.8 chars/token).
    // Apply a length penalty: avgLen < 2.5 → garbage; >= 2.5 → no penalty.
    // Max penalty 0.80 so partially-real docs still score something.
    const WORD_FORMING = new Set(['arabic', 'persian', 'hebrew']);
    if (WORD_FORMING.has(lang)) {
      const avgLen = scriptAvgTokenLen(text, lang);
      if (avgLen !== null && avgLen < 2.5) {
        const lenPenalty = Math.min(0.80, (2.5 - avgLen) / 1.5);
        scriptScore *= (1 - lenPenalty);
      }
    }
    // Multiply by printableRatio: if 40% of chars are control-char garbage, max quality is 60%.
    return Math.round(pr * scriptScore * 100) / 100;
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
  // Space-injection detection: broken PDFs produce consonant-cluster fragments as tokens —
  // 'th', 'ph', 'sh', 'wh', 'ts', 'ng', 'ck', 'st' etc. These 2-3 char tokens with no vowels
  // are virtually absent in natural prose but appear at 5-20% in space-injected PDFs.
  // Include 'y' as vowel to avoid false positives on real English words 'by','my','gy' etc.
  const zvTokens = sample.filter(w => w.length <= 3 && !/[aeiouàáâãäåæèéêëìíîïðòóôõöùúûüýy]/i.test(w)).length;
  const zvRatio = sample.length > 0 ? zvTokens / sample.length : 0;
  // Threshold 0.03: virtually no real prose has consonant clusters at this rate
  const spaceInjectionPenalty = zvRatio > 0.03 ? (zvRatio - 0.03) * 4 : 0;
  const noise = ocrNoiseRatio(text);
  return Math.max(0, Math.round(pr * Math.max(0, realWords.length / sample.length - noise * 3 - spaceInjectionPenalty) * 100) / 100);
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
    // Split on form feed to find page segments; pdf-parse may produce more \f splits than actual
    // pages (e.g. 9 segments for a 2-page PDF), so use segment count as denominator, not sampleMax.
    const pageTexts = sampleText.split('\f');
    const segCount = Math.max(pageTexts.length, 1);
    const readableInSample = pageTexts.filter(p => p.replace(/\s/g, '').length >= 50).length;
    const readablePct = Math.min(1, readableInSample / segCount);
    const avgChars = sampleText.length / sampleMax;
    const hasTextRaw = avgChars > 5 ? 1 : 0;
    // Detect language first so wordQuality uses the correct word set
    const langSample = [pdf_title, sampleText.slice(0, 2000)].join(' ');
    const language = detectLanguage(langSample);
    // Garbled text layer detection: legacy font encoding produces Latin Extended / PUA chars
    // at high density even though the PDF claims to have a text layer. Treat as image PDF.
    const garbled = hasTextRaw === 1 && isGarbledTextLayer(sampleText.slice(0, 5000), language);
    const hasText = garbled ? 0 : hasTextRaw;
    const wq = garbled ? 0 : wordQuality(sampleText.slice(0, 5000), language);
    // Printable char ratio: custom-encoded PDFs may have many control chars (pdf-parse decoding)
    // or ASCII-substituted glyphs. Use as a scaling factor on charsScore.
    const pr = printableRatio(sampleText);
    const charsScore = garbled ? 0 : Math.min(avgChars * pr / 500, 1);
    // adjustedReadable: just use readablePct directly — no charsScore floor.
    // The old floor (charsScore*0.85) inflated scores for docs with lots of garbage chars.
    const adjustedReadable = readablePct;
    // wq dominates: a document with garbage text can't score high regardless of char count.
    // Readable page fraction and char density scale wq's contribution; small fixed credits
    // for having chars at all (so image PDFs can still be assessed and queued for OCR).
    const composite = Math.min(1, wq * (0.6 + 0.3 * adjustedReadable) + 0.07 * charsScore + 0.03 * hasText);
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
  const wq = metrics.word_quality_estimate ?? 0;
  if (hasText === 1 && wq < 0.05) {
    // Completely garbled encoding (custom font, mojibake) — treat as image PDF
    hasText = 0;
    composite = Math.min(composite, 0.15);
  } else if (hasText === 1 && wq < 0.8) {
    // Low-quality text layer: chars/page score inflates composite above threshold even for garbage.
    // Only skip OCR upgrade when text is genuinely clean (wq >= 0.8 = "perfect").
    composite = Math.min(composite, 0.65);
  }
  db.prepare(`INSERT OR REPLACE INTO pdf_quality (url, content_hash, scored_at, avg_chars_per_page, readable_pages_pct, has_text_layer, word_quality_estimate, composite_score, pages, pdf_title, excerpt, ai_language, processing_difficulty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(url, contentHash, new Date().toISOString(), metrics.avg_chars_per_page, metrics.readable_pages_pct, hasText, metrics.word_quality_estimate, composite, metrics.pages, metrics.pdf_title || null, metrics.excerpt || null, language, metrics.processing_difficulty ?? null);
};
/** Queue a PDF for upgrade if below score threshold. Text-layer PDFs are top priority (fast pipeline pass). */
export const maybeQueue = (db, url, contentHash, score, threshold = 0.7, language = null, hasTextLayer = null) => {
  if (score >= threshold) return false;
  const localPath = db.prepare('SELECT local_path FROM pages WHERE url=?').get(url)?.local_path;
  if (!localPath || !existsSync(localPath)) return false;
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
