// Multi-stage identification pipeline for image PDFs (no text layer). Exports: identifyDocument. Deps: tesseract, Anthropic, reocr, fs
// Stage 1: pdftoppm rasterize + Tesseract OSD (script detection) + OCR rough text
// Stage 2: Claude Haiku interprets text + metadata → language, title, author, summary
// Stage 3: Boss vision LLM escalation when Haiku cannot identify from text alone
// Results saved to pdf_quality only — NOT part of the OCR upgrade pipeline.
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { identifyPage, ocrAvailableBackend } from './reocr.js';
import { logLlmCall, llmCost } from '../db.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const TESSERACT_TIMEOUT_MS = 30_000;
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_PAGES_TO_SAMPLE = 2;

// Known script → tesseract language pack mapping
const SCRIPT_TO_LANG = {
  arabic: 'ara', Persian: 'fas', Hebrew: 'heb',
  Cyrillic: 'rus', Han: 'chi_sim', Hangul: 'kor',
  Devanagari: 'hin', Japanese: 'jpn',
  Latin: 'eng',
};

// Tesseract script name → our canonical language key
const SCRIPT_TO_KEY = {
  arabic: 'arabic', Persian: 'persian', Hebrew: 'hebrew',
  Cyrillic: 'russian', Han: 'chinese', Japanese: 'japanese',
  Latin: 'english',
};

/** Rasterize one PDF page to a temp PPM using pdftoppm. Returns file path or null. */
const rasterizePage = async (pdfPath, pageNo, outDir) => {
  const base = join(outDir, `p${String(pageNo).padStart(3, '0')}`);
  try {
    await execFileAsync('pdftoppm', ['-r', '150', '-f', String(pageNo), '-l', String(pageNo), pdfPath, base], {
      timeout: TESSERACT_TIMEOUT_MS
    });
    // pdftoppm outputs base-NNN.ppm
    const candidate = `${base}-${String(pageNo).padStart(3, '0')}.ppm`;
    if (existsSync(candidate)) return candidate;
    // fallback: find any .ppm with this base
    const { stdout } = await execAsync(`ls "${base}"*.ppm 2>/dev/null || true`);
    const matches = stdout.trim().split('\n').filter(Boolean);
    return matches[0] || null;
  } catch { return null; }
};

/** Run Tesseract OSD (script detection) on an image. Returns { script, confidence } or null. */
const tesseractOSD = async (imgPath) => {
  try {
    const { stdout } = await execFileAsync('tesseract', [imgPath, 'stdout', '--osd', '--psm', '0'], {
      timeout: TESSERACT_TIMEOUT_MS
    });
    const scriptMatch = stdout.match(/Script:\s*(\S+)/i);
    const confMatch = stdout.match(/Script confidence:\s*([\d.]+)/i);
    if (!scriptMatch) return null;
    return { script: scriptMatch[1], confidence: confMatch ? parseFloat(confMatch[1]) : 0 };
  } catch { return null; }
};

/** Run Tesseract OCR on an image with the given language pack. Returns text string. */
const tesseractOCR = async (imgPath, lang = 'eng') => {
  try {
    const { stdout } = await execFileAsync('tesseract', [imgPath, 'stdout', '-l', lang, '--psm', '3'], {
      timeout: TESSERACT_TIMEOUT_MS
    });
    return stdout.trim();
  } catch { return ''; }
};

/**
 * Stage 1: Run Tesseract on first 1-2 pages. Returns { script, ocrText }.
 * Uses OSD to detect script, then OCR with matching language pack.
 */
const tesseractSample = async (pdfPath) => {
  const workDir = join(tmpdir(), `identify-${randomBytes(4).toString('hex')}`);
  mkdirSync(workDir, { recursive: true });
  const cleanup = [];
  try {
    let script = 'Latin';
    let ocrText = '';
    for (let page = 1; page <= MAX_PAGES_TO_SAMPLE; page++) {
      const imgPath = await rasterizePage(pdfPath, page, workDir);
      if (!imgPath || !existsSync(imgPath)) break;
      cleanup.push(imgPath);
      if (page === 1) {
        const osd = await tesseractOSD(imgPath);
        if (osd && osd.confidence > 1) script = osd.script;
      }
      const lang = SCRIPT_TO_LANG[script] || 'eng';
      const text = await tesseractOCR(imgPath, lang);
      ocrText += (ocrText ? '\n\n' : '') + text;
    }
    return { script, ocrText: ocrText.slice(0, 3000) };
  } finally {
    for (const f of cleanup) { try { unlinkSync(f); } catch {} }
    try { await execAsync(`rm -rf "${workDir}"`); } catch {}
  }
};

/**
 * Stage 2: Claude Haiku identifies document from OCR text + anchor metadata.
 * Returns { language, title, author, summary } or null on API failure / all-Unknown.
 */
const haikuIdentify = async (ocrText, script, metadata, apiKey, db, url) => {
  const { hostedTitle, pdfTitle, excerpt, hostPageSnippet } = metadata;
  const context = [
    hostedTitle && `Link text: "${hostedTitle}"`,
    pdfTitle && `PDF metadata title: "${pdfTitle}"`,
    hostPageSnippet && `From hosting page: "${hostPageSnippet.slice(0, 400)}"`,
    ocrText && `OCR text sample:\n${ocrText.slice(0, 1200)}`,
    excerpt && `Existing excerpt: "${excerpt}"`,
  ].filter(Boolean).join('\n\n');

  if (!context.trim()) return null;

  const prompt = `Identify this PDF document from the available clues.
Script detected by OCR: ${script}

${context}

Respond with exactly these 4 lines (use "Unknown" if you cannot determine):
Language: [English/Arabic/Persian/Hebrew/Russian/Japanese/Chinese/other]
Title: [document title]
Author: [author name or organization]
Summary: [one sentence describing what this document is about]`;

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });
    if (db && url) logLlmCall(db, { stage: 'identify', url, page_no: null, provider: 'claude', model: HAIKU_MODEL, tokens_in: msg.usage?.input_tokens || 0, tokens_out: msg.usage?.output_tokens || 0, cost_usd: llmCost(HAIKU_MODEL, msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0), ok: 1 });
    const text = msg.content[0]?.text?.trim() || '';
    const get = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s*(.+)`, 'im'));
      return m ? m[1].trim() : null;
    };
    const language = get('Language');
    const title = get('Title');
    const author = get('Author');
    const summary = get('Summary');
    const hasInfo = [language, title, author, summary].some(v => v && v.toLowerCase() !== 'unknown');
    return hasInfo ? { language, title, author, summary } : null;
  } catch { return null; }
};

/** Normalize a free-form language name to our canonical key. */
const normalizeLanguageKey = (lang) => {
  if (!lang) return 'unknown';
  const l = lang.toLowerCase();
  if (l.includes('english')) return 'english';
  if (l.includes('arabic')) return 'arabic';
  if (l.includes('persian') || l.includes('farsi')) return 'persian';
  if (l.includes('hebrew')) return 'hebrew';
  if (l.includes('russian') || l.includes('cyrillic')) return 'russian';
  if (l.includes('japanese')) return 'japanese';
  if (l.includes('chinese') || l.includes('mandarin')) return 'chinese';
  return 'unknown';
};

/**
 * Identify a single image-only PDF document using the three-stage pipeline.
 * Saves results to pdf_quality in the given db.
 * @param {string} pdfPath - local file path
 * @param {object} metadata - { hostedTitle, pdfTitle, excerpt, hostPageSnippet }
 * @param {object} db - better-sqlite3 db instance
 * @param {string} docUrl - document URL (for DB update)
 * @param {string|null} apiKey - Anthropic API key (null skips Haiku stage)
 * @returns {{ language, title, author, summary, langKey, stage }}
 */
export const identifyDocument = async (pdfPath, metadata, db, docUrl, apiKey) => {
  // Stage 1: Tesseract (async subprocesses — safe to run many in parallel)
  let script = 'Latin';
  let ocrText = '';
  try {
    ({ script, ocrText } = await tesseractSample(pdfPath));
  } catch {}

  // Quick script → language key (free, no API)
  let langKey = SCRIPT_TO_KEY[script] || 'unknown';
  let result = null;

  // Stage 2: Haiku (if API key and we have anything to interpret)
  if (apiKey && (ocrText.length > 20 || metadata.hostedTitle || metadata.pdfTitle)) {
    result = await haikuIdentify(ocrText, script, metadata, apiKey, db, docUrl);
    if (result) {
      const normalized = normalizeLanguageKey(result.language);
      langKey = normalized !== 'unknown' ? normalized : langKey;
      result.langKey = langKey;
      result.stage = 'haiku';
    }
  }

  // Stage 3: Vision LLM (boss or Claude fallback) — only escalate if both above yielded nothing
  if (!result && langKey === 'unknown') {
    try {
      const backend = await ocrAvailableBackend();
      if (backend) {
        const { language, topic } = await identifyPage(pdfPath, backend, db, docUrl);
        if (language || topic) {
          const normalized = normalizeLanguageKey(language);
          langKey = normalized !== 'unknown' ? normalized : langKey;
          result = { language: language || null, title: null, author: null, summary: topic || null, langKey, stage: backend };
        }
      }
    } catch {}
  }

  // Save to DB
  const updates = [];
  const vals = [];
  if (langKey && langKey !== 'unknown') {
    updates.push('ai_language=?'); vals.push(langKey);
  } else if (!db.prepare('SELECT ai_language FROM pdf_quality WHERE url=?').get(docUrl)?.ai_language) {
    updates.push('ai_language=?'); vals.push('unknown');
  }
  if (result?.title && result.title.toLowerCase() !== 'unknown') {
    updates.push('pdf_title=?'); vals.push(result.title.slice(0, 200));
  }
  if (result?.author && result.author.toLowerCase() !== 'unknown') {
    updates.push('ai_author=?'); vals.push(result.author.slice(0, 200));
  }
  if (result?.summary && result.summary.toLowerCase() !== 'unknown') {
    updates.push('ai_summary=?'); vals.push(result.summary.slice(0, 500));
    updates.push("summary_tier='identified'");
  }
  if (updates.length) {
    vals.push(docUrl);
    db.prepare(`UPDATE pdf_quality SET ${updates.join(', ')} WHERE url=?`).run(...vals);
  }

  return result ? { ...result, langKey } : { language: null, title: null, author: null, summary: null, langKey, stage: 'none' };
};
