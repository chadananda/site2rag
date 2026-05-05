// Domain detection cascade: site profile → rich caller context → pattern match → Haiku.
// Exports: detectDomain, buildPromptContext, SUBJECT_BUCKETS. Deps: config.js (llmCost)
//
// Callers can supply unprocessed context via ctx.meta — the more they provide, the better:
//   ctx.meta.pageText        — visible text of the page the PDF was linked from (500 char cap)
//   ctx.meta.pageTitle       — HTML <title> of the linking page
//   ctx.meta.anchorText      — the link text used to download the PDF
//   ctx.meta.siteDescription — site-level description (meta description, about page excerpt)
//   ctx.meta.contextHints    — free-form string of anything the caller thinks is relevant
//   ctx.meta.keywords        — string[] of caller-supplied topic hints
//   ctx.meta.title           — PDF title from metadata
//   ctx.meta.language        — language code if known
//
// Privacy: signals are metadata only. pageText is truncated to 500 chars and never stored.

import { llmCost } from './config.js';

export const SUBJECT_BUCKETS = {
  'religious-texts':   ['bahai', 'quran', 'bible', 'scripture', 'theology', 'sufi', 'islamic',
                        'buddhist', 'hindu', 'jewish', 'torah', 'liturgy', 'prayer', 'covenant'],
  'legal':             ['law', 'court', 'statute', 'legislation', 'treaty', 'contract',
                        'regulation', 'ordinance', 'judicial', 'plaintiff', 'defendant'],
  'scientific':        ['journal', 'research', 'study', 'clinical', 'experiment', 'biology',
                        'chemistry', 'physics', 'medicine', 'hypothesis', 'methodology'],
  'historical':        ['archive', 'manuscript', 'letter', 'memoir', 'diary', 'correspondence',
                        'chronicle', 'census', 'colonial', 'revolution'],
  'literary':          ['poetry', 'poem', 'novel', 'fiction', 'literature', 'essay',
                        'narrative', 'prose', 'anthology', 'verse'],
  'governmental':      ['government', 'ministry', 'official', 'report', 'bureau', 'commission',
                        'parliament', 'senate', 'department', 'policy'],
  'technical':         ['engineering', 'manual', 'specification', 'standard', 'patent',
                        'schematic', 'procedure', 'protocol', 'system', 'design'],
};

const SCRIPT_SIGNALS = {
  'arabic':   ['arabic', 'quran', 'hadith', 'arabic-script'],
  'persian':  ['persian', 'farsi', 'iran', 'bahai', 'baha'],
  'hebrew':   ['hebrew', 'jewish', 'torah', 'talmud'],
  'cyrillic': ['russian', 'cyrillic', 'soviet', 'slavic'],
  'cjk':      ['chinese', 'japanese', 'korean', 'kanji', 'hanzi'],
};

const ERA_PATTERNS = [
  { pattern: /\b1[5-7]\d{2}\b/, era: '1500-1799', label: 'early-modern' },
  { pattern: /\b18\d{2}\b/,     era: '1800-1899', label: '19th-century' },
  { pattern: /\b19[0-4]\d\b/,   era: '1900-1949', label: 'early-20th-century' },
  { pattern: /\b19[5-9]\d\b/,   era: '1950-1999', label: 'mid-late-20th-century' },
];

/** Zero-cost token record for non-LLM paths. */
const NO_TOKENS = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

/**
 * Main entry. Enriches ctx.domain in-place.
 * Returns { tokens_in, tokens_out, cost_usd } so callers can include in stage totals.
 *
 * Cascade (each layer short-circuits when confident enough):
 *   L1  Site profile      — config.lookupDomainProfile(host), confidence >= 0.80
 *   L2  Rich context      — Haiku distillation when caller supplies pageText/contextHints
 *   L3  Pattern match     — keyword scoring on thin metadata (URL, title, anchor)
 *   L4  Haiku fallback    — Haiku on thin signals when confidence < 0.75
 */
export async function detectDomain(ctx) {
  const signals = gatherSignals(ctx);

  // L1: cached site profile (free, highest trust when doc_count is high)
  if (ctx.config.lookupDomainProfile) {
    const profile = await ctx.config.lookupDomainProfile(signals.host);
    if (profile?.confidence >= 0.80) {
      ctx.domain = buildDomainFromProfile(profile, 'site_profile');
      ctx.addDecision('s0', 'domain_detected',
        `site_profile confidence=${profile.confidence.toFixed(2)}`, profile.confidence);
      return NO_TOKENS;
    }
  }

  // L2: caller-supplied rich context → Haiku distillation (runs before pattern match
  // because page text + link text is better signal than our keyword patterns)
  if (signals.richContext && ctx.config.apiKey) {
    try {
      const { domain, tokens_in, tokens_out, cost_usd } = await distillWithHaiku(signals, ctx.config.apiKey);
      ctx.domain = domain;
      ctx.addDecision('s0', 'domain_detected',
        `haiku_rich_context confidence=${domain.confidence.toFixed(2)}`, domain.confidence);
      return { tokens_in, tokens_out, cost_usd };
    } catch (err) {
      ctx.addError('s0', new Error(`domain_detect haiku failed: ${err.message}`), true);
    }
  }

  // L3: pattern matching on thin metadata (always available, no API needed)
  const l3 = matchPatterns(signals);
  if (l3.confidence >= 0.75) {
    ctx.domain = l3;
    ctx.addDecision('s0', 'domain_detected',
      `pattern_match confidence=${l3.confidence.toFixed(2)}`, l3.confidence);
    return NO_TOKENS;
  }

  // L4: Haiku on thin signals (last resort — still better than pattern match alone)
  if (ctx.config.apiKey && signals.hasAnySignal) {
    try {
      const { domain, tokens_in, tokens_out, cost_usd } = await distillWithHaiku(signals, ctx.config.apiKey);
      ctx.domain = domain;
      ctx.addDecision('s0', 'domain_detected',
        `haiku_thin_signals confidence=${domain.confidence.toFixed(2)}`, domain.confidence);
      return { tokens_in, tokens_out, cost_usd };
    } catch (err) {
      ctx.addError('s0', new Error(`domain_detect haiku fallback failed: ${err.message}`), true);
    }
  }

  // Final fallback: pattern match result
  ctx.domain = l3;
  ctx.addDecision('s0', 'domain_detected',
    `pattern_match_fallback confidence=${l3.confidence.toFixed(2)}`, l3.confidence);
  return NO_TOKENS;
}

/**
 * Gather metadata signals from ctx. Never reads document body.
 * pageText is capped at 500 chars — enough to understand context, not enough to be content.
 */
function gatherSignals(ctx) {
  const url = ctx.sourceUrl ?? '';
  const host = safeHost(url);
  const urlPath = url.split('/').slice(3).join(' ');

  // Caller-supplied signals (all optional)
  const pdfTitle    = (ctx.meta?.title ?? '').slice(0, 200);
  const anchorText  = (ctx.meta?.anchorText ?? '').slice(0, 300);
  const pageTitle   = (ctx.meta?.pageTitle ?? '').slice(0, 200);
  const siteDesc    = (ctx.meta?.siteDescription ?? '').slice(0, 200);
  const pageText    = (ctx.meta?.pageText ?? '').slice(0, 500);   // surrounding page context
  const contextHints = (ctx.meta?.contextHints ?? '').slice(0, 300);
  const keywords    = (ctx.meta?.keywords ?? []).slice(0, 10).join(' ');
  const language    = ctx.quality?.baseline?.language ?? ctx.meta?.language ?? null;
  const excerpt     = (ctx.quality?.baseline?.excerpt ?? '').slice(0, 200);

  const thinSignals = [host, urlPath, pdfTitle, anchorText, pageTitle, siteDesc, keywords];
  const combined    = thinSignals.join(' ').toLowerCase();

  // richContext = caller gave us something substantive beyond the PDF URL itself
  const richContext = !!(pageText || contextHints || (anchorText.length > 20) || (pageTitle && pageTitle !== pdfTitle));

  return {
    host, urlPath, combined,
    pdfTitle, anchorText, pageTitle, siteDesc,
    pageText, contextHints, keywords,
    language, excerpt,
    richContext,
    hasAnySignal: !!(pdfTitle || anchorText || siteDesc || excerpt || pageTitle || contextHints),
  };
}

/** Score each subject bucket against combined thin-signal text. */
function matchPatterns(signals) {
  const text = signals.combined;
  const scores = {};
  for (const [bucket, keywords] of Object.entries(SUBJECT_BUCKETS)) {
    scores[bucket] = keywords.filter(k => text.includes(k)).length / keywords.length;
  }

  const [subject, rawScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const confidence = Math.min(0.95, rawScore * 3);

  const scripts = Object.entries(SCRIPT_SIGNALS)
    .filter(([, kws]) => kws.some(k => text.includes(k)))
    .map(([s]) => s);
  const primaryScript = scripts[0] ?? 'latin';
  const scriptContext = scripts.length > 1
    ? `Mixed ${scripts.slice(0, 2).join(' and ')} script`
    : primaryScript === 'latin' ? 'Latin script'
    : `${primaryScript.charAt(0).toUpperCase() + primaryScript.slice(1)} script`;

  const eraMatch = ERA_PATTERNS.find(e => e.pattern.test(signals.pdfTitle + ' ' + signals.urlPath));
  const era = eraMatch?.era ?? null;

  const subdomains = [
    ...scripts,
    ...(era ? [eraMatch.label] : []),
    ...(signals.language && signals.language !== 'unknown' ? [signals.language] : []),
  ].filter(Boolean);

  return {
    subject, subdomains, era, script_context: scriptContext, confidence,
    source: 'pattern_match',
    prompt_context: buildPromptContext({ subject, subdomains, era, script_context: scriptContext }),
  };
}

/**
 * Distill all available signals into a structured domain object via Haiku.
 * Returns { domain, tokens_in, tokens_out, cost_usd } so callers can log the spend.
 */
async function distillWithHaiku(signals, apiKey) {
  const MODEL = 'claude-haiku-4-5-20251001';
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const lines = [
    'Distill the following context clues about a document into a structured domain profile.',
    'The profile will be used to guide an OCR correction model.',
    '',
    signals.host          ? `Domain: ${signals.host}` : null,
    signals.pdfTitle      ? `Document title: ${signals.pdfTitle}` : null,
    signals.anchorText    ? `Link text used to download it: ${signals.anchorText}` : null,
    signals.pageTitle     ? `Page it was found on: ${signals.pageTitle}` : null,
    signals.siteDesc      ? `Site description: ${signals.siteDesc}` : null,
    signals.pageText      ? `Surrounding page text: ${signals.pageText}` : null,
    signals.contextHints  ? `Additional context from caller: ${signals.contextHints}` : null,
    signals.keywords      ? `Keywords: ${signals.keywords}` : null,
    signals.language      ? `Detected language: ${signals.language}` : null,
    signals.excerpt       ? `Document text sample: ${signals.excerpt}` : null,
    '',
    'Return JSON only:',
    '{ "subject": string, "subdomains": string[], "era": string|null, "script_context": string,',
    '  "confidence": 0.0-1.0, "prompt_context": string }',
    '',
    `subject: one of [${Object.keys(SUBJECT_BUCKETS).join(', ')}, general]`,
    'prompt_context: 2-4 sentence expert briefing for the OCR model — name specific vocabulary,',
    '  proper names, conventions, or script features it should know about for this document type.',
  ].filter(l => l !== null).join('\n');

  const resp = await client.messages.create({
    model: MODEL, max_tokens: 350,
    messages: [{ role: 'user', content: lines }],
  });

  const tokens_in  = resp.usage?.input_tokens  ?? 0;
  const tokens_out = resp.usage?.output_tokens ?? 0;
  const cost_usd   = llmCost(MODEL, tokens_in, tokens_out);

  const raw  = resp.content[0]?.text ?? '{}';
  const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');

  const domain = {
    subject:        json.subject ?? 'general',
    subdomains:     Array.isArray(json.subdomains) ? json.subdomains : [],
    era:            json.era ?? null,
    script_context: json.script_context ?? 'Latin script',
    confidence:     Math.min(0.95, Number(json.confidence) || 0.6),
    source:         signals.richContext ? 'haiku_rich_context' : 'haiku_thin_signals',
    prompt_context: json.prompt_context ?? buildPromptContext(json),
  };

  return { domain, tokens_in, tokens_out, cost_usd };
}

function buildDomainFromProfile(profile, source) {
  return {
    subject:        profile.subject,
    subdomains:     JSON.parse(profile.subdomains ?? '[]'),
    era:            profile.era ?? null,
    script_context: profile.script_context ?? 'Latin script',
    confidence:     profile.confidence,
    source,
    prompt_context: profile.prompt_context,
  };
}

/** Build a prompt context string from domain components. Returns null for 'general'. */
export function buildPromptContext({ subject, subdomains = [], era, script_context } = {}) {
  if (!subject || subject === 'general') return null;
  const parts = [`This is a ${subject.replace(/-/g, ' ')} document`];
  if (era) parts[0] += ` from the ${era} period`;
  if (script_context && script_context !== 'Latin script') parts.push(`written in ${script_context}`);
  if (subdomains.length) parts.push(`with specialized vocabulary related to: ${subdomains.slice(0, 3).join(', ')}`);
  return parts.join('. ') + '.';
}

function safeHost(url) {
  try {
    return new URL(url?.startsWith('http') ? url : 'https://unknown.invalid').hostname.replace(/^www\./, '');
  } catch { return 'unknown'; }
}
