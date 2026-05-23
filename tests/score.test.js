import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-score-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';
import { scorePdf, saveQualityScore, maybeQueue, extractBadSample, wordQuality, extractExcerpt, scriptConsistency, ocrNoiseRatio } from '../src/pdf-upgrade/score.js';

const DOMAIN = 'score.example.com';

/** Build a 1-page text PDF using ghostscript (produces a PDF that pdf-parse can read). */
function makeTextPdf(text = 'The quick brown fox jumps over the lazy dog') {
  const outPath = join(tmpdir(), `score-test-${Date.now()}.pdf`);
  const lines = text.match(/.{1,80}/g) || [text];
  const psLines = lines.slice(0, 5).map((l, i) => {
    const safe = l.replace(/[()\\]/g, '\\$&');
    return `72 ${720 - i * 20} moveto (${safe}) show`;
  }).join('\n');
  const ps = `%!PS-Adobe-3.0\n/Helvetica findfont 12 scalefont setfont\n${psLines}\nshowpage\n`;
  execSync(`gs -q -sDEVICE=pdfwrite -dNOPAUSE -dBATCH -dCompatibilityLevel=1.4 -sOutputFile=${outPath} -`, { input: ps });
  return readFileSync(outPath);
}

describe('scorePdf', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = join(testRoot, 'pdfs');
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns zero metrics for nonexistent path', async () => {
    const result = await scorePdf(join(tmpDir, 'ghost.pdf'));
    expect(result.composite_score).toBe(0);
    expect(result.has_text_layer).toBe(0);
    expect(result.pages).toBe(0);
  });

  it('returns zero metrics for a non-PDF file', async () => {
    const path = join(tmpDir, 'fake.pdf');
    writeFileSync(path, 'this is not a pdf');
    const result = await scorePdf(path);
    expect(result.composite_score).toBe(0);
  });

  it('detects text layer and scores above zero for a text PDF', async () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const path = join(tmpDir, 'text.pdf');
    writeFileSync(path, makeTextPdf(text.slice(0, 200)));
    const result = await scorePdf(path);
    expect(result.has_text_layer).toBe(1);
    expect(result.composite_score).toBeGreaterThan(0);
    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.language).toBe('english');
  });

  it('returns language=unknown for a PDF with no recognisable text', async () => {
    const path = join(tmpDir, 'empty-stream.pdf');
    // PDF with empty stream — has_text_layer=0, language=unknown
    writeFileSync(path, makeTextPdf(''));
    const result = await scorePdf(path);
    expect(result.language).toBe('unknown');
  });
});

describe('scriptConsistency', () => {
  it('returns high score for genuine Persian text', () => {
    const persian = 'دفتر سوّم مباحث ایّام ادرنه ملاحظاتی در لوح نازله به اعزاز ملاّ عبدالرّحیم وحید رأفتی توصیف کلمة الل در آثار قلم اعلی ایرج ایمن ذیلی در بارۀ مبانی احکام محمّد افنان';
    expect(scriptConsistency(persian, 'persian')).toBeGreaterThan(0.6);
  });

  it('returns low score for Latin OCR garbage labelled as Persian', () => {
    const garbage = 'abc def ghi jkl mno pqr stu vwx yz ab cde fgh ijk lmn opq rst uvw xyz';
    expect(scriptConsistency(garbage, 'persian')).toBeLessThan(0.1);
  });

  it('returns null for a language with no defined ranges (English)', () => {
    expect(scriptConsistency('hello world test text long enough sample here now', 'english')).toBeNull();
  });

  it('returns null for too-short text (<20 non-space chars)', () => {
    expect(scriptConsistency('سلام', 'persian')).toBeNull();
  });
});

describe('wordQuality — non-Latin scripts', () => {
  it('scores genuine Persian text high', () => {
    const persian = 'دفتر سوّم مباحث ایّام ادرنه ملاحظاتی در لوح نازله به اعزاز ملاّ عبدالرّحیم وحید رأفتی توصیف کلمة الل در آثار قلم اعلی ایرج ایمن ذیلی در بارۀ مبانی احکام محمّد افنان بررسی مضامین قصیدۀ تائیۀ کبری';
    expect(wordQuality(persian, 'persian')).toBeGreaterThan(0.5);
  });

  it('scores Latin OCR garbage on a Persian doc near zero', () => {
    const garbage = 'xP kL mRn wQz bVj pT sWx rNm yKp dLq fJh gMv cBn tRs uYe vZw';
    expect(wordQuality(garbage, 'persian')).toBeLessThan(0.2);
  });

  it('scores English text correctly via word-list path', () => {
    const english = 'The quick brown fox jumps over the lazy dog and the cat sat on the mat with great pleasure indeed';
    expect(wordQuality(english, 'english')).toBeGreaterThan(0.5);
  });
});

describe('saveQualityScore', () => {
  let db;
  beforeEach(() => {
    mkdirSync(join(testRoot, 'pdfs'), { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('inserts a new quality row', () => {
    const metrics = { avg_chars_per_page: 500, readable_pages_pct: 0.9, has_text_layer: 1, word_quality_estimate: 0.8, composite_score: 0.75, pages: 3, pdf_title: 'Test', excerpt: 'Sample text', language: 'english' };
    saveQualityScore(db, 'https://score.example.com/doc.pdf', 'sha256:abc', metrics);
    const row = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get('https://score.example.com/doc.pdf');
    expect(row).toBeTruthy();
    expect(row.composite_score).toBe(0.75);
    expect(row.has_text_layer).toBe(1);
    expect(row.ai_language).toBe('english');
    expect(row.pages).toBe(3);
  });

  it('upserts on re-score (same url, new hash)', () => {
    const base = { avg_chars_per_page: 100, readable_pages_pct: 0.5, has_text_layer: 0, word_quality_estimate: 0.3, composite_score: 0.2, pages: 1, pdf_title: '', excerpt: '', language: 'unknown' };
    saveQualityScore(db, 'https://score.example.com/doc.pdf', 'sha256:v1', base);
    saveQualityScore(db, 'https://score.example.com/doc.pdf', 'sha256:v2', { ...base, composite_score: 0.85 });
    const row = db.prepare('SELECT composite_score FROM pdf_quality WHERE url=?').get('https://score.example.com/doc.pdf');
    expect(row.composite_score).toBe(0.85);
  });

  it('URL-encoded Arabic in URL overrides text-extracted language', () => {
    // Arabic chars in URL percent-encode as %D8xx-%DBxx → detectLanguageFromUrl returns 'arabic'
    const arabicUrl = 'https://score.example.com/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/doc.pdf';
    const metrics = { avg_chars_per_page: 200, readable_pages_pct: 0.5, has_text_layer: 0, word_quality_estimate: 0.3, composite_score: 0.4, pages: 2, pdf_title: '', excerpt: '', language: 'english' };
    saveQualityScore(db, arabicUrl, 'sha256:arabic', metrics);
    const row = db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(arabicUrl);
    expect(row.ai_language).toBe('arabic');
  });

  it('stores processing_difficulty from metrics', () => {
    const metrics = { avg_chars_per_page: 300, readable_pages_pct: 0.7, has_text_layer: 1, word_quality_estimate: 0.6, composite_score: 0.65, pages: 5, pdf_title: '', excerpt: '', language: 'english', processing_difficulty: 0.05 };
    saveQualityScore(db, 'https://score.example.com/difficulty.pdf', 'sha256:diff', metrics);
    const row = db.prepare('SELECT processing_difficulty FROM pdf_quality WHERE url=?').get('https://score.example.com/difficulty.pdf');
    expect(row.processing_difficulty).toBeCloseTo(0.05, 2);
  });
});

describe('maybeQueue', () => {
  let db;
  // maybeQueue skips if PDF not downloaded — seed pages table with a real local_path
  function seedPage(url) {
    const fname = url.split('/').pop().replace(/[^a-z0-9.]/gi, '_');
    const localPath = join(testRoot, 'pdfs', fname);
    writeFileSync(localPath, 'dummy');
    db.prepare('INSERT OR IGNORE INTO pages (url, local_path) VALUES (?,?)').run(url, localPath);
  }
  beforeEach(() => {
    mkdirSync(join(testRoot, 'pdfs'), { recursive: true });
    db = openDb(DOMAIN);
  });
  afterEach(() => { db.close(); rmSync(testRoot, { recursive: true, force: true }); });

  it('queues a low-score PDF', () => {
    seedPage('https://score.example.com/low.pdf');
    const result = maybeQueue(db, 'https://score.example.com/low.pdf', 'sha256:low', 0.3, 0.7, 'english');
    expect(result).toBe(true);
    const row = db.prepare("SELECT * FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/low.pdf');
    expect(row).toBeTruthy();
    expect(row.status).toBe('pending');
    expect(row.priority).toBeGreaterThan(0);
  });

  it('does not queue a high-score PDF', () => {
    const result = maybeQueue(db, 'https://score.example.com/high.pdf', 'sha256:high', 0.85, 0.7, 'english');
    expect(result).toBe(false);
    const row = db.prepare("SELECT * FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/high.pdf');
    expect(row).toBeUndefined();
  });

  it('does not re-queue a doc already processing or done', () => {
    db.prepare("INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at) VALUES (?,?,?,?,?)").run('https://score.example.com/inprog.pdf', 'sha256:x', 0.5, 'processing', new Date().toISOString());
    const result = maybeQueue(db, 'https://score.example.com/inprog.pdf', 'sha256:x', 0.2, 0.7, 'english');
    expect(result).toBe(false);
  });

  it('priority is higher for english than arabic at same score', () => {
    seedPage('https://score.example.com/en.pdf');
    seedPage('https://score.example.com/ar.pdf');
    maybeQueue(db, 'https://score.example.com/en.pdf', 'sha256:en', 0.3, 0.7, 'english');
    maybeQueue(db, 'https://score.example.com/ar.pdf', 'sha256:ar', 0.3, 0.7, 'arabic');
    const en = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/en.pdf');
    const ar = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/ar.pdf');
    expect(en.priority).toBeGreaterThan(ar.priority);
  });

  it('text-layer PDFs get 100x boost in priority', () => {
    seedPage('https://score.example.com/text.pdf');
    seedPage('https://score.example.com/image.pdf');
    maybeQueue(db, 'https://score.example.com/text.pdf', 'sha256:text', 0.3, 0.7, 'english', 1);
    maybeQueue(db, 'https://score.example.com/image.pdf', 'sha256:img', 0.3, 0.7, 'english', 0);
    const textRow = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/text.pdf');
    const imgRow = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/image.pdf');
    expect(textRow.priority).toBeGreaterThan(imgRow.priority * 50);
  });

  it('re-queues a pending doc with new priority (INSERT OR REPLACE)', () => {
    seedPage('https://score.example.com/requeue.pdf');
    maybeQueue(db, 'https://score.example.com/requeue.pdf', 'sha256:v1', 0.3, 0.7, 'english');
    const first = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/requeue.pdf');
    // Re-queue with higher score still below threshold
    maybeQueue(db, 'https://score.example.com/requeue.pdf', 'sha256:v2', 0.1, 0.7, 'english');
    const second = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get('https://score.example.com/requeue.pdf');
    // Lower score = higher (1-score) = higher priority
    expect(second.priority).toBeGreaterThan(first.priority);
  });

  it('uses DB-stored ai_language over passed language when DB has non-unknown value', () => {
    // Seed pdf_quality with ai_language='arabic' (corrected by detectLanguageForImagePdfs)
    const url = 'https://score.example.com/dblang.pdf';
    db.prepare(`INSERT INTO pdf_quality (url, content_hash, scored_at, ai_language, composite_score, has_text_layer, pages)
      VALUES (?,?,?,?,?,?,?)`).run(url, 'sha256:x', new Date().toISOString(), 'arabic', 0.3, 0, 2);
    // Pass language='english' — DB 'arabic' should win
    seedPage(url);
    maybeQueue(db, url, 'sha256:x', 0.3, 0.7, 'english');
    const row = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get(url);
    // arabic has LANG_PRIORITY=0.02, english=1.0 → arabic priority much lower
    // If DB lang was used (arabic), priority should be very small
    expect(row.priority).toBeLessThan(0.1);
  });

  it('URL percent-encoded Arabic overrides language for priority calculation', () => {
    // Arabic URL → detectLanguageFromUrl returns 'arabic' → deeply deprioritized
    const arabicUrl = 'https://score.example.com/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/doc.pdf';
    const englishUrl = 'https://score.example.com/english-doc.pdf';
    seedPage(arabicUrl);
    seedPage(englishUrl);
    maybeQueue(db, arabicUrl, 'sha256:arabic', 0.3, 0.7, 'english');
    maybeQueue(db, englishUrl, 'sha256:english', 0.3, 0.7, 'english');
    const arabicRow = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get(arabicUrl);
    const englishRow = db.prepare("SELECT priority FROM pdf_upgrade_queue WHERE url=?").get(englishUrl);
    expect(englishRow.priority).toBeGreaterThan(arabicRow.priority);
  });
});

describe('saveQualityScore', () => {
  let db;
  beforeEach(() => {
    mkdirSync(join(testRoot, 'pdfs'), { recursive: true });
    db = openDb('score2.example.com');
  });
  afterEach(() => { db.close(); });

  it('caps composite_score for custom-encoded text layer (wq < 0.05)', () => {
    // PDF with has_text_layer=1 but word_quality < 0.05 => custom font encoding, not real text
    const metrics = {
      avg_chars_per_page: 100, readable_pages_pct: 0.8, has_text_layer: 1,
      word_quality_estimate: 0.02, composite_score: 0.70, pages: 5,
      pdf_title: '', excerpt: '', language: 'unknown', processing_difficulty: 0.05
    };
    saveQualityScore(db, 'https://score2.example.com/garbled.pdf', 'sha256:garbled', metrics);
    const row = db.prepare('SELECT * FROM pdf_quality WHERE url=?').get('https://score2.example.com/garbled.pdf');
    // composite capped to <= 0.15 and has_text_layer set to 0
    expect(row.composite_score).toBeLessThanOrEqual(0.15);
    expect(row.has_text_layer).toBe(0);
  });
});

describe('wordQuality', () => {
  it('returns 0 for null/empty text', () => {
    expect(wordQuality(null)).toBe(0);
    expect(wordQuality('')).toBe(0);
    expect(wordQuality('   ')).toBe(0);
  });

  it('returns 0 when fewer than 10 tokens', () => {
    expect(wordQuality('hello world foo')).toBe(0);
  });

  it('returns high score for clean English text', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    expect(wordQuality(text, 'english')).toBeGreaterThan(0.5);
  });

  it('returns low score for garbled OCR (all consonants)', () => {
    const garbled = Array.from({ length: 20 }, (_, i) => 'bcdfghjklmn'.repeat(3) + i).join(' ');
    expect(wordQuality(garbled)).toBeLessThan(0.3);
  });

  it('returns low score for repeated-character garbage', () => {
    // Words with 4+ repeated chars are filtered by heuristic
    const garbage = Array.from({ length: 20 }, (_, i) => 'aaaa' + i + 'bbbb').join(' ');
    expect(wordQuality(garbage)).toBeLessThan(0.3);
  });

  it('returns a value between 0 and 1', () => {
    const text = 'Natural language text with many common words and sentences. '.repeat(15);
    const score = wordQuality(text);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('uses LANG_WORDS for non-english languages when available', () => {
    // French text — should score reasonably when lang='french'
    const frenchText = 'le la les de du des un une et est dans pour par sur avec ce qui que'.split(' ').join(' ') + ' ';
    const score = wordQuality(frenchText.repeat(3), 'french');
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe('ocrNoiseRatio', () => {
  it('returns near zero for clean English prose', () => {
    const clean = 'The quick brown fox jumps over the lazy dog. Natural language text with many common words. '.repeat(5);
    expect(ocrNoiseRatio(clean)).toBeLessThan(0.05);
  });

  it('returns high ratio for text with digit substitutions', () => {
    // Words like c1one, d0ne, 0nce, b8se, s5op embedded in otherwise normal text
    const noisy = 'c1one d0ne 0nce b8se s5op l1ve g0ne w1th m0re f1nd t1me h1gh b1g c0de d1g '.repeat(5);
    expect(ocrNoiseRatio(noisy)).toBeGreaterThan(0.5);
  });

  it('returns 0 for too few letter-dominant tokens (<10)', () => {
    expect(ocrNoiseRatio('c1one d0ne')).toBe(0);
  });

  it('penalises wordQuality for noisy Latin text', () => {
    const clean = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    const noisy = 'c1one d0ne 0nce b8se s5op l1ve g0ne w1th m0re f1nd t1me h1gh c0de '.repeat(8);
    expect(wordQuality(clean, 'english')).toBeGreaterThan(wordQuality(noisy, 'english'));
  });
});

describe('extractExcerpt', () => {
  it('returns empty string for null/empty input', () => {
    expect(extractExcerpt(null)).toBe('');
    expect(extractExcerpt('')).toBe('');
  });

  it('finds the first capitalized sentence of sufficient length', () => {
    const text = 'some preamble\fThe quick brown fox jumps over the lazy dog and keeps running forever.';
    const result = extractExcerpt(text);
    expect(result).toMatch(/^The quick/);
  });

  it('truncates to maxChars', () => {
    const text = 'The ' + 'a'.repeat(300);
    const result = extractExcerpt(text, 50);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('falls back to cleaned text when no capitalized sentence found', () => {
    const text = 'abcdef ghijkl mnopqr stuvwx yz';
    const result = extractExcerpt(text, 280);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('replaces form-feed characters with spaces', () => {
    const text = 'The quick\fbrown fox jumps over the lazy dog and continues onward.';
    const result = extractExcerpt(text);
    expect(result).not.toContain('\f');
  });

  it('collapses whitespace in output', () => {
    const text = 'The   quick    brown   fox   jumps over the lazy dog and continues.';
    const result = extractExcerpt(text);
    expect(result).not.toMatch(/\s{2,}/);
  });
});

describe('extractBadSample', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = join(testRoot, 'pdfs'); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns empty string for nonexistent file', () => {
    expect(extractBadSample(join(tmpDir, 'ghost.pdf'))).toBe('');
  });

  it('returns truncated text sample from a file', () => {
    const path = join(tmpDir, 'sample.pdf');
    writeFileSync(path, Buffer.from('Some readable words here to test the sample extraction function returns text'));
    const result = extractBadSample(path, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(typeof result).toBe('string');
  });
});
