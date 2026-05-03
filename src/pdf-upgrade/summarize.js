// Haiku API summaries for pending PDF upgrade queue items. Exports: summarizeTopPending. Deps: Anthropic, db, language
import Anthropic from '@anthropic-ai/sdk';
import { detectLanguage } from '../language.js';
import { logLlmCall, llmCost } from '../db.js';

const log = (msg) => console.log(`[pdf-upgrade] ${new Date().toISOString().slice(0,19)} ${msg}`);
const SUMMARIZE_BATCH = 100;
const SUMMARIZE_CONCURRENCY = 20;
const NON_ENGLISH = new Set(['arabic','persian','hebrew','japanese','chinese']);
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/** Generate Haiku AI summaries for top N pending queue items without existing summaries. */
export const summarizeTopPending = async (db, domain) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const rows = db.prepare(`
    SELECT pq.url, pq.pdf_title, pq.excerpt, pq.ai_language,
           h.hosted_title, h.host_url as source_url,
           COALESCE(q.priority, 0.5) as priority
    FROM pdf_quality pq
    LEFT JOIN pdf_upgrade_queue q ON pq.url = q.url
    LEFT JOIN hosts h ON pq.url = h.hosted_url
    WHERE pq.ai_summarized_at IS NULL AND COALESCE(pq.skip, 0) != 1
      AND COALESCE(pq.ai_language, 'unknown') NOT IN ('arabic','persian','hebrew','japanese','chinese')
    ORDER BY priority DESC, pq.composite_score DESC
    LIMIT ?`).all(SUMMARIZE_BATCH);
  if (!rows.length) return;

  const client = new Anthropic({ apiKey });
  let done = 0;

  const summarizeOne = async (row) => {
    try {
      const title = row.hosted_title || row.pdf_title || null;
      if (!row.ai_language || row.ai_language === 'unknown') {
        const sample = [title, row.excerpt].filter(Boolean).join(' ');
        const detected = detectLanguage(sample);
        if (detected && detected !== 'unknown') {
          db.prepare('UPDATE pdf_quality SET ai_language=? WHERE url=?').run(detected, row.url);
          if (NON_ENGLISH.has(detected)) {
            db.prepare('UPDATE pdf_quality SET ai_summarized_at=? WHERE url=?').run(new Date().toISOString(), row.url);
            done++; return;
          }
        }
      }
      const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
      const displayTitle = title || (slug.length > 3 && !/^\d+$/.test(slug.trim()) ? slug : null);
      if (!displayTitle && !row.excerpt && !row.source_url) {
        db.prepare('UPDATE pdf_quality SET ai_summarized_at=? WHERE url=?').run(new Date().toISOString(), row.url);
        done++; return;
      }
      const prompt = `Metadata for a PDF document:\n${[
        displayTitle && `Title: ${displayTitle}`,
        `URL: ${row.url}`,
        row.source_url && `Source page: ${row.source_url}`,
        row.excerpt && `Excerpt: ${row.excerpt.slice(0, 500)}`
      ].filter(Boolean).join('\n')}\n\nRespond with exactly two plain-text lines (no markdown, no numbering):\nLine 1: one sentence describing this document.\nLine 2: Author: [full name, or Unknown]`;
      const msg = await client.messages.create({
        model: HAIKU_MODEL, max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      });
      logLlmCall(db, { stage: 'summarize', url: row.url, page_no: null, provider: 'claude', model: HAIKU_MODEL, tokens_in: msg.usage?.input_tokens || 0, tokens_out: msg.usage?.output_tokens || 0, cost_usd: llmCost(HAIKU_MODEL, msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0), ok: 1 });
      const text = msg.content[0]?.text || '';
      const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const summary = lines[0] || null;
      const authorLine = lines.find(l => l.toLowerCase().startsWith('author:'));
      const author = authorLine ? authorLine.replace(/^author:\s*/i, '').trim() : null;
      db.prepare('UPDATE pdf_quality SET ai_summary=?, ai_author=?, summary_tier=?, ai_summarized_at=? WHERE url=?')
        .run(summary, author, 'haiku', new Date().toISOString(), row.url);
      done++;
    } catch (e) {
      log(`summarize failed: ${row.url}: ${e.message}`);
    }
  };

  for (let i = 0; i < rows.length; i += SUMMARIZE_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + SUMMARIZE_CONCURRENCY).map(summarizeOne));
  }
  if (done) log(`Summarized ${done} pending docs via Haiku`);
};
