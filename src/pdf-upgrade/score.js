// PDF quality scoring -- heuristics only, no AI. Composite score 0.0 (unreadable) to 1.0 (clean).
import pdfParse from 'pdf-parse';
import { readFileSync } from 'fs';
// Common English function words for word quality estimation
const COMMON_WORDS = new Set(['the','of','and','to','a','in','is','it','you','that','he','was','for','on','are','as','with','his','they','at','be','this','from','or','had','by','not','but','have','an','were','we','their','one','all','would','there','what','so','up','out','if','about','who','get','which','go','me','when','make','can','like','time','no','just','him','know','take','into','year','your','good','some','could','them','see','other','than','then','now','look','only','come','its','over','think','also','back','after','use','two','how','our','first','well','way','even','new','want','because','any','these','give','day','most','us']);
/** Estimate word quality from a text sample. Returns 0-1. */
const wordQuality = (text) => {
  if (!text || !text.trim()) return 0;
  const tokens = text.replace(/[^a-zA-Z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2 && w.length <= 20);
  if (tokens.length < 10) return 0;
  const sample = tokens.slice(0, 200);
  const realWords = sample.filter(w => {
    const lower = w.toLowerCase();
    if (COMMON_WORDS.has(lower)) return true;
    // Heuristic: real words have reasonable consonant/vowel patterns
    const vowels = (lower.match(/[aeiou]/g) || []).length;
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
export const scorePdf = async (pdfPath) => {
  const empty = { avg_chars_per_page: 0, readable_pages_pct: 0, has_text_layer: 0, word_quality_estimate: 0, composite_score: 0, pages: 0 };
  try {
    const buf = readFileSync(pdfPath);
    let data;
    try { data = await pdfParse(buf, { max: 0 }); } catch { return empty; }
    const pages = data.numpages || 1;
    const totalChars = (data.text || '').length;
    const avgChars = totalChars / pages;
    const hasText = avgChars > 5 ? 1 : 0;
    // Split by form-feed to get per-page text
    const pageTexts = (data.text || '').split('\f');
    const readablePages = pageTexts.filter(p => p.replace(/\s/g, '').length >= 50).length;
    const readablePct = pages > 0 ? readablePages / pages : 0;
    // Word quality on a sample of the full text
    const sampleText = (data.text || '').slice(0, 5000);
    const wq = wordQuality(sampleText);
    // Composite: weighted sum
    const charsScore = Math.min(avgChars / 500, 1); // saturates at 500 chars/page
    const composite = 0.4 * wq + 0.3 * readablePct + 0.2 * charsScore + 0.1 * hasText;
    return { avg_chars_per_page: Math.round(avgChars), readable_pages_pct: Math.round(readablePct * 100) / 100, has_text_layer: hasText, word_quality_estimate: Math.round(wq * 100) / 100, composite_score: Math.round(composite * 100) / 100, pages };
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
  db.prepare(`INSERT OR REPLACE INTO pdf_quality (url, content_hash, scored_at, avg_chars_per_page, readable_pages_pct, has_text_layer, word_quality_estimate, composite_score, pages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(url, contentHash, new Date().toISOString(), metrics.avg_chars_per_page, metrics.readable_pages_pct, metrics.has_text_layer, metrics.word_quality_estimate, metrics.composite_score, metrics.pages);
};
/** Queue a PDF for upgrade if below score threshold. */
export const maybeQueue = (db, url, contentHash, score, threshold = 0.7) => {
  if (score >= threshold) return false;
  const existing = db.prepare('SELECT status FROM pdf_upgrade_queue WHERE url=?').get(url);
  if (existing && existing.status !== 'pending') return false; // already processed or in progress
  db.prepare(`INSERT OR REPLACE INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at)
    VALUES (?, ?, ?, 'pending', ?)`)
    .run(url, contentHash, 1 - score, new Date().toISOString());
  return true;
};
