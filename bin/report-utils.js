// API response utilities: HTML stripping, link context, free summary, doc mapping. Exports: stripHtml, getLinkContext, buildFreeSummary, mapDoc, buildSummaryPrompt. Deps: language
import { detectLanguage, LANG_COST, LANG_DISPLAY } from '../src/language.js';
import { spellFixCost } from '../src/pdf-upgrade/spell-fix.js';

/** Strip HTML tags and decode common entities. */
export const stripHtml = (html) => html
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Extract the paragraph surrounding a PDF link in a host page's HTML. */
export const getLinkContext = (html, pdfUrl) => {
  const candidates = [pdfUrl.split('/').pop(), decodeURIComponent(pdfUrl.split('/').pop())];
  for (const needle of candidates) {
    const idx = html.indexOf(needle);
    if (idx < 0) continue;
    const pStart = html.lastIndexOf('<p', idx);
    const pEnd = html.indexOf('</p>', idx);
    const start = (pStart > 0 && pStart > idx - 1000) ? pStart : Math.max(0, idx - 400);
    const end   = (pEnd > 0  && pEnd  < idx + 1000)  ? pEnd + 4 : Math.min(html.length, idx + 400);
    const ctx = stripHtml(html.slice(start, end)).slice(0, 600).trim();
    if (ctx.length > 30) return ctx;
  }
  return null;
};

/** Compose a free (no-API) summary from available metadata. */
export const buildFreeSummary = (row) => {
  const title = row.title || null;
  const domain = row.source_url ? row.source_url.replace(/^https?:\/\//, '').split('/')[0] : null;
  const excerpt = row.excerpt ? row.excerpt.replace(/\s+/g, ' ').trim() : null;
  if (title && excerpt && excerpt.length > 40) {
    const short = excerpt.length > 160 ? excerpt.slice(0, 160).replace(/\s\S*$/, '…') : excerpt;
    return domain ? `${title} — ${short} [${domain}]` : `${title} — ${short}`;
  }
  if (excerpt && excerpt.length > 40) {
    return excerpt.length > 200 ? excerpt.slice(0, 200).replace(/\s\S*$/, '…') : excerpt;
  }
  if (title && domain) return `${title} (from ${domain})`;
  return title || null;
};

/** Transform a DB doc row to API response shape with language normalization + effort estimate. */
export const titleFromUrl = (url) => {
  try {
    const u = new URL(url);
    const dl = u.searchParams.get('dl');
    const raw = (dl || u.pathname.split('/').pop() || '').replace(/\.pdf$/i, '');
    // Strip leading numeric timestamp prefix (e.g. "1770651898-history-of-aliyabad" → "history-of-aliyabad")
    const cleaned = raw.replace(/^\d{8,}-/, '');
    return cleaned.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || null;
  } catch { return null; }
};

export const isGenericTitle = (t) => !t || t.length <= 5 || /^pdf$/i.test(t.trim());

export const mapDoc = (d, domain) => {
  const title = isGenericTitle(d.title) ? (titleFromUrl(d.url) || d.title || null) : d.title;
  const ai_summary = d.ai_summary || buildFreeSummary(d) || null;
  const summary_tier = d.summary_tier || (ai_summary && !d.ai_summary ? 'free' : null);
  const langKey = d.ai_language || detectLanguage([d.excerpt, title].filter(Boolean).join(' ')) || 'unknown';
  const ai_language = LANG_DISPLAY[langKey] ?? null;
  const lang_cost_mult = LANG_COST[langKey] ?? LANG_COST.unknown;
  const pages = d.pages || 0;
  const readablePct = d.readable_pages_pct ?? 0;
  const pagesNeeded = Math.round(pages * (1 - readablePct));
  const effort_mins = pagesNeeded > 0 ? Math.max(1, Math.round(pagesNeeded * 0.5 * lang_cost_mult)) : 0;

  // Parse upgrade history into a score trail: [orig, after_pass1, after_pass2, ...]
  const history = (() => { try { return JSON.parse(d.upgrade_history || 'null') || []; } catch { return []; } })();
  const score_trail = history.length > 0
    ? [history[0].score_before, ...history.map(h => h.score_after)].filter(x => x != null)
    : [];
  // PDF type classification from pre-upgrade signals
  const hasTextLayer = d.has_text_layer === 1;
  const readablePctRaw = d.readable_pages_pct ?? null;
  // image = no text layer at all; mixed = has text layer but low readability; text = good text layer
  const pdf_type = !hasTextLayer ? 'image'
    : (readablePctRaw != null && readablePctRaw < 0.4) ? 'mixed'
    : 'text';
  // Parse pipeline receipt for step-by-step method display with per-stage gains
  const _receipt = (() => { try { return JSON.parse(d.receipt_json || 'null'); } catch { return null; } })();

  // Effective before/after scores: before_score (stored at submit) > history > receipt baseline
  const historyBefore = history.find(h => h.score_before != null)?.score_before ?? null;
  const receiptBaseline = _receipt?.quality?.baseline?.composite_score ?? null;
  const effective_before = d.before_score ?? historyBefore ?? receiptBaseline ?? null;
  const effective_after = d.after_score != null ? Math.min(d.after_score, 1) : null;
  const effective_improvement = (effective_before != null && effective_after != null) ? effective_after - effective_before : null;
  const method_summary = _receipt?.method_summary ?? null;
  const method_steps = (() => {
    if (!_receipt) return null;
    const { stages = [], quality = {} } = _receipt;
    const perStage = quality.per_stage ?? {};
    // Use real site-level gain if we have before_score, else fall back to pipeline's internal gain
    const totalGainPct = effective_improvement != null
      ? Math.round(effective_improvement * 100)
      : (quality.gain != null ? Math.round(quality.gain * 100) : null);
    const stageOrder = ['s3', 's4', 's5', 's6', 's7'];
    const label = {
      s3: s => { const l = s.notes?.match(/^[a-z+]+$/i)?.[0]; return l ? `OCR (${l})` : 'Multi-engine OCR'; },
      s4: () => 'Vision Escalate',
      s5: s => { const a = s.approach ?? ''; return a.includes('claude') ? 'Claude Vision' : a.includes('boss') ? 'Boss Vision' : 'Vision'; },
      s6: () => 'Spell Fix',
      s7: () => 'PDF/A Archive',
    };
    // Build steps with per-stage gain deltas where available
    let prevScore = perStage['s0'] ?? quality.baseline?.composite_score ?? null;
    const steps = [];
    for (const stageId of stageOrder) {
      const s = stages.find(x => x.stage === stageId);
      if (!s || s.pages_affected <= 0) continue;
      const lbl = label[stageId]?.(s);
      if (!lbl) continue;
      const stageScore = perStage[stageId] ?? null;
      const delta = (stageScore != null && prevScore != null) ? Math.round((stageScore - prevScore) * 100) : null;
      if (stageScore != null) prevScore = stageScore;
      steps.push({ label: lbl, delta });
    }
    return steps.length ? { totalGainPct, steps } : null;
  })();

  // Cost estimates for upgrade options
  const avgChars = d.avg_chars_per_page || 1500;
  const spell_fix_cost_usd = pages > 0 ? spellFixCost(pages, avgChars) : 0;
  const vision_cost_usd    = pages > 0 ? pages * 0.003 * (LANG_COST[langKey] ?? 1) : 0; // Haiku vision

  return {
    ...d,
    title,
    ai_summary,
    summary_tier,
    ai_language,
    lang_key: langKey,
    effort_mins,
    score_trail,
    upgrade_history_parsed: history,
    pdf_type,
    effective_before,
    effective_after,
    effective_improvement,
    method_steps,
    method_summary,
    receipt_json: undefined,
    spell_fix_cost_usd,
    vision_cost_usd,
    archive_url: d.status === 'done' && d.upgraded_pdf_path
      ? `https://${domain}.lnker.com/_upgraded/${d.path_slug || d.url.replace(/[^a-z0-9]/gi,'_').slice(-60)}.pdf`
      : null,
  };
};

/** Build Haiku summarization prompt for a batch row. Returns null if insufficient metadata. */
export const buildSummaryPrompt = (row) => {
  const title = row.hosted_title || row.pdf_title || null;
  const slug = row.url.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim();
  const displayTitle = title || (slug.length > 3 && !/^\d+$/.test(slug.trim()) ? slug : null);
  if (!displayTitle && !row.excerpt && !row.source_url) return null;
  return `Metadata for a PDF document:\n${[
    displayTitle && `Title: ${displayTitle}`,
    `URL: ${row.url}`,
    row.source_url && `Source page: ${row.source_url}`,
    row.excerpt && `Excerpt: ${row.excerpt.slice(0, 500)}`
  ].filter(Boolean).join('\n')}\n\nRespond with exactly two plain-text lines (no markdown, no numbering):\nLine 1: one sentence describing this document.\nLine 2: Author: [full name, or Unknown]`;
};
