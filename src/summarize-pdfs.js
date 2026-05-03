// Summarize unsummarized image PDFs with Claude Haiku. Runs after scoring, time-budgeted.
import Anthropic from '@anthropic-ai/sdk';
import { cpus } from 'os';
import { logLlmCall, llmCost } from './db.js';

const CONCURRENCY = Math.max(4, Math.floor(cpus().length / 4));
const BUDGET_MS = 10 * 60 * 1000; // 10 min max per run

const detectLanguage = (text) => {
  if (!text || text.length < 15) return 'unknown';
  const len = text.length;
  if ((text.match(/[\u0600-\u06FF]/g) || []).length / len > 0.07)
    return (text.match(/[\u067E\u0686\u0698\u06AF]/g) || []).length > 0 ? 'persian' : 'arabic';
  if ((text.match(/[\u0590-\u05FF]/g) || []).length / len > 0.07) return 'hebrew';
  if ((text.match(/[\u3040-\u30FF]/g) || []).length / len > 0.05) return 'japanese';
  if ((text.match(/[\u4E00-\u9FFF]/g) || []).length / len > 0.07) return 'chinese';
  if ((text.match(/[\u0400-\u04FF]/g) || []).length / len > 0.07) return 'russian';
  if ((text.match(/[a-zA-Z]/g) || []).length / len > 0.3) return 'english';
  return 'unknown';
};

const buildPrompt = (row) => {
  const slug = (row.url || '').split('/').pop().replace(/\.pdf$/i, '').replace(/[-_]/g, ' ').trim();
  const title = row.hosted_title || row.pdf_title || (slug.length > 3 ? slug : null);
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  parts.push(`URL: ${row.url}`);
  if (row.source_url) parts.push(`Found on: ${row.source_url}`);
  if (row.excerpt?.length > 40) parts.push(`\nDocument excerpt:\n${row.excerpt.slice(0, 400)}`);
  if (!title && !row.excerpt) return null;
  const lang = detectLanguage([row.excerpt, row.pdf_title, row.hosted_title].filter(Boolean).join(' '));
  return `Context clues for a PDF document (language: ${lang}):\n${parts.join('\n')}\n\nRespond with exactly two plain-text lines.\nLine 1: One original sentence describing what this document is about.\nLine 2: Author: [full name only, or Unknown]`;
};

export const runSummarizePdfs = async (db, siteConfig) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { summarized: 0, skipped: 0 };

  let rows;
  try {
    rows = db.prepare(`
      SELECT q.url, q.pdf_title, q.excerpt,
             h.hosted_title, h.host_url as source_url
      FROM pdf_quality q
      LEFT JOIN (SELECT hosted_url, MIN(host_url) as host_url, MIN(hosted_title) as hosted_title
                 FROM hosts GROUP BY hosted_url) h ON q.url=h.hosted_url
      WHERE q.ai_summarized_at IS NULL
        AND (q.has_text_layer=0 OR q.has_text_layer IS NULL OR q.readable_pages_pct < 0.4)
      ORDER BY COALESCE(q.composite_score, 1) ASC
      LIMIT 2000`).all();
  } catch (e) {
    console.warn(`[summarize] query failed (schema migration pending?): ${e.message}`);
    return { summarized: 0, skipped: 0 };
  }

  if (!rows.length) return { summarized: 0, skipped: 0 };

  const client = new Anthropic({ apiKey });
  const started = Date.now();
  let summarized = 0, skipped = 0;

  const processOne = async (row) => {
    if (Date.now() - started > BUDGET_MS) return;
    const prompt = buildPrompt(row);
    if (!prompt) { skipped++; return; }
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 120,
        messages: [{ role: 'user', content: prompt }]
      });
      logLlmCall(db, { stage: 'summarize', url: row.url, page_no: null, provider: 'claude', model: 'claude-haiku-4-5-20251001', tokens_in: msg.usage?.input_tokens || 0, tokens_out: msg.usage?.output_tokens || 0, cost_usd: llmCost('claude-haiku-4-5-20251001', msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0), ok: 1 });
      const text = msg.content[0]?.text || '';
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const summary = lines[0] || null;
      const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
      const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
      const lang = detectLanguage([row.excerpt, row.pdf_title, row.hosted_title].filter(Boolean).join(' '));
      db.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, ai_language=?, summary_tier=?, ai_summarized_at=? WHERE url=?')
        .run(summary, author, lang, 'haiku', new Date().toISOString(), row.url);
      summarized++;
    } catch (e) {
      console.warn(`[summarize] ${row.url}: ${e.message}`);
    }
  };

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    if (Date.now() - started > BUDGET_MS) break;
    await Promise.all(rows.slice(i, i + CONCURRENCY).map(processOne));
  }

  console.log(`[summarize] ${summarized} summarized, ${skipped} skipped (${Math.round((Date.now()-started)/1000)}s)`);
  return { summarized, skipped };
};
