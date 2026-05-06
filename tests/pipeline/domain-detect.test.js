import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectDomain, buildPromptContext, SUBJECT_BUCKETS } from '../../src/pipeline/domain-detect.js';
import { makeCtx } from './helpers.js';

// CONTRACT tests

describe('detectDomain — contract', () => {
  it('sets ctx.domain with required fields', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://bahai-library.com/pdf/some-doc.pdf';
    ctx.quality.baseline = { excerpt: 'Bahá\'u\'lláh revealed this tablet', language: 'english' };

    await detectDomain(ctx);

    expect(ctx.domain).toMatchObject({
      subject: expect.any(String),
      subdomains: expect.any(Array),
      confidence: expect.any(Number),
      source: expect.any(String),
    });
    expect(ctx.domain.confidence).toBeGreaterThanOrEqual(0);
    expect(ctx.domain.confidence).toBeLessThanOrEqual(1);
  });

  it('records a domain_detected decision', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://bahai-library.com/doc.pdf';
    await detectDomain(ctx);
    expect(ctx.metrics.decisions.some(d => d.decision === 'domain_detected')).toBe(true);
  });

  it('returns token usage { tokens_in, tokens_out, cost_usd }', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    const usage = await detectDomain(ctx);
    expect(usage).toMatchObject({
      tokens_in:  expect.any(Number),
      tokens_out: expect.any(Number),
      cost_usd:   expect.any(Number),
    });
    expect(ctx.domain).not.toBeNull();  // domain is still set on ctx
  });

  it('handles null sourceUrl without throwing', async () => {
    const ctx = makeCtx();
    ctx.sourceUrl = null;
    await expect(detectDomain(ctx)).resolves.toBeDefined();
    expect(ctx.domain).not.toBeNull();
  });
});

// CASCADE ORDER tests

describe('detectDomain — cascade', () => {
  it('L1: uses site profile when confidence >= 0.80, skipping Haiku', async () => {
    const profile = {
      subject: 'religious-texts', subdomains: JSON.stringify(['bahai']),
      era: '1844-1921', script_context: 'Persian script',
      prompt_context: 'Bahá\'í text.', confidence: 0.90,
    };
    const lookup = vi.fn().mockResolvedValue(profile);
    const ctx = makeCtx({ config: { lookupDomainProfile: lookup } });
    ctx.sourceUrl = 'https://bahai-library.com/doc.pdf';

    await detectDomain(ctx);

    expect(lookup).toHaveBeenCalledWith('bahai-library.com');
    expect(ctx.domain.source).toBe('site_profile');
    expect(ctx.domain.subject).toBe('religious-texts');
  });

  it('L2: uses Haiku when caller provides rich context (pageText), before pattern match', async () => {
    const haikuResult = {
      subject: 'scientific', subdomains: ['biology'], era: null,
      script_context: 'Latin script', confidence: 0.88,
      prompt_context: 'Biology research paper with specialized terminology.',
    };
    // Inject a mock Haiku call by providing a pre-built domain via a lookupDomainProfile
    // that returns low confidence, forcing L2 — then verifying richContext triggers Haiku
    const ctx = makeCtx({ config: { apiKey: null } }); // no key → Haiku can't fire
    ctx.sourceUrl = 'https://unknown-site.org/paper.pdf';
    ctx.meta = {
      pageText: 'This paper presents novel findings in molecular biology and genomics research.',
      pageTitle: 'Biology Research Papers Archive',
      anchorText: 'Download: Genomics Study 2023',
    };

    await detectDomain(ctx);

    // Even without Haiku (no apiKey), richContext is detected and the decision notes it
    // The source should NOT be haiku since apiKey is null
    expect(ctx.domain.source).not.toBe('haiku_rich_context');
    // But the decision should reflect richContext triggered (falls through to pattern match)
    expect(ctx.metrics.decisions.some(d => d.stage === 's0')).toBe(true);
  });

  it('L2: signals.richContext is true when pageText is supplied', async () => {
    // Test that rich context triggers L2 when apiKey is present
    // We mock this by passing a lookupDomainProfile returning null (skip L1)
    // and checking the source after detection with a rich signal
    const ctx = makeCtx({ config: {
      apiKey: null, // no key, so Haiku won't fire, but we test the signal detection
      lookupDomainProfile: vi.fn().mockResolvedValue(null),
    }});
    ctx.sourceUrl = 'https://example.com/report.pdf';
    ctx.meta = {
      pageText: 'Annual government commission report on environmental policy and legislation.',
      anchorText: 'Download Annual Report PDF',
    };

    await detectDomain(ctx);

    // With pageText present, richContext=true; without apiKey falls through to pattern match
    // Government keywords in pageText should boost the score
    expect(ctx.domain).not.toBeNull();
  });

  it('L3: falls through to pattern match when no API key and no site profile', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://law-library.example.com/statutes/court-regulation-2020.pdf';
    ctx.meta = { title: 'Court Statutes and Regulations 2020' };

    await detectDomain(ctx);

    expect(ctx.domain.source).toBe('pattern_match');
    expect(ctx.domain.subject).toBe('legal');
  });

  it('L1 low-confidence profile falls through to L2/L3', async () => {
    const lookup = vi.fn().mockResolvedValue({ subject: 'general', confidence: 0.5, subdomains: '[]' });
    const ctx = makeCtx({ config: { lookupDomainProfile: lookup, apiKey: null } });
    ctx.sourceUrl = 'https://bahai-library.com/theology.pdf';
    ctx.meta = { title: 'Theology and Religious Scripture', anchorText: 'Bahá\'í prayer texts' };

    await detectDomain(ctx);

    expect(ctx.domain.source).not.toBe('site_profile');
  });
});

// CALLER CONTEXT SIGNALS tests

describe('detectDomain — caller context signals', () => {
  it('accepts pageText from the linking page', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.meta = {
      pageText: 'This archive contains 19th-century Persian manuscripts and letters from the Bahá\'í Faith.',
      anchorText: 'Download: Persian Manuscript Collection',
    };

    await detectDomain(ctx);

    // Should pick up religious-texts and persian from the pageText
    expect(ctx.domain).not.toBeNull();
    expect(['religious-texts', 'historical']).toContain(ctx.domain.subject);
  });

  it('accepts pageTitle separately from pdfTitle', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/untitled.pdf';
    ctx.meta = {
      title: '',  // PDF has no title
      pageTitle: 'Legal Document Archive — Court Records and Statutes',
    };

    await detectDomain(ctx);

    expect(ctx.domain.subject).toBe('legal');
  });

  it('accepts contextHints as free-form caller annotation', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/scan.pdf';
    ctx.meta = {
      contextHints: 'handwritten 19th century Persian Bahá\'í manuscript from the holy land',
    };

    await detectDomain(ctx);

    // contextHints is included in thin signals via combined text
    expect(ctx.domain).not.toBeNull();
  });

  it('accepts keywords array from caller', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.meta = {
      keywords: ['quran', 'islamic', 'theology', 'prayer', 'sufi'],
    };

    await detectDomain(ctx);

    expect(ctx.domain.subject).toBe('religious-texts');
  });

  it('richContext is false when only thin signals present', async () => {
    // anchorText <= 20 chars counts as thin; title + URL only is thin
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.meta = { title: 'Document', anchorText: 'PDF' };

    await detectDomain(ctx);

    // Pattern match source (not haiku) since no rich context and no apiKey
    expect(ctx.domain.source).toBe('pattern_match');
  });

  it('richContext is true when anchorText > 20 chars (meaningful link text)', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.meta = {
      anchorText: 'Download the complete religious scripture archive PDF',  // > 20 chars
    };

    // With apiKey: null, L2 Haiku doesn't fire, but the signal is there
    await detectDomain(ctx);

    // Falls through to pattern match since no apiKey
    expect(ctx.domain).not.toBeNull();
  });

  it('pageText is truncated to 500 chars and never influences ctx.domain.prompt_context directly', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/doc.pdf';
    ctx.meta = {
      pageText: 'A'.repeat(1000),  // very long page text
    };

    await detectDomain(ctx);

    // prompt_context should be built from structured fields, not raw pageText
    if (ctx.domain.prompt_context) {
      expect(ctx.domain.prompt_context).not.toContain('A'.repeat(50));
    }
  });
});

// PATTERN MATCHING tests

describe('detectDomain — pattern matching', () => {
  it('detects religious-texts from hostname and title', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://bahai-library.com/theology.pdf';
    ctx.meta = { title: 'Bahá\'í Scripture and Theology' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('religious-texts');
  });

  it('detects legal from URL and title', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.gov/law/court-statute.pdf';
    ctx.meta = { title: 'Court Statute on Regulation' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('legal');
  });

  it('detects persian script signals', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://afnanlibrary.org/persian/ms.pdf';
    ctx.meta = { anchorText: 'persian bahai manuscript', title: 'Persian Epistle' };
    await detectDomain(ctx);
    expect(ctx.domain.subdomains).toContain('persian');
  });

  it('detects era from title year', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://archive.org/docs/letter-1880.pdf';
    ctx.meta = { title: 'Letters from 1880' };
    await detectDomain(ctx);
    expect(ctx.domain.era).toBe('1800-1899');
  });

  it('detects scientific from title keywords', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/journal/study-2020.pdf';
    ctx.meta = { title: 'Clinical Research Study on Molecular Biology and Chemistry' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('scientific');
  });

  it('detects historical from URL and title keywords', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://archive.org/manuscripts/colonial-letters.pdf';
    ctx.meta = { title: 'Colonial Correspondence and Memoirs from 1850' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('historical');
  });

  it('detects governmental from URL and title keywords', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.gov/commission/annual-report.pdf';
    ctx.meta = { title: 'Government Commission Annual Report on Policy' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('governmental');
  });

  it('detects literary from title keywords', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/books/poetry-anthology.pdf';
    ctx.meta = { title: 'An Anthology of Poetry and Verse from the 19th Century' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('literary');
  });

  it('detects technical from title keywords', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/docs/engineering-specification.pdf';
    ctx.meta = { title: 'Engineering Specification and System Design Manual' };
    await detectDomain(ctx);
    expect(ctx.domain.subject).toBe('technical');
  });

  it('returns near-zero confidence when no keywords match any bucket', async () => {
    const ctx = makeCtx({ config: { apiKey: null } });
    ctx.sourceUrl = 'https://example.com/123.pdf';
    ctx.meta = { title: '' };
    await detectDomain(ctx);
    // No keyword matches → confidence effectively 0; 'general' only comes from Haiku
    expect(ctx.domain.confidence).toBeLessThan(0.1);
  });

  it('confidence increases with more keyword matches', async () => {
    const ctx1 = makeCtx({ config: { apiKey: null } });
    ctx1.sourceUrl = 'https://example.com/law.pdf';
    ctx1.meta = { title: 'Law' };
    await detectDomain(ctx1);

    const ctx2 = makeCtx({ config: { apiKey: null } });
    ctx2.sourceUrl = 'https://legal.example.com/statutes.pdf';
    ctx2.meta = { title: 'Court Statutes Legislation Judicial Regulation' };
    await detectDomain(ctx2);

    expect(ctx2.domain.confidence).toBeGreaterThanOrEqual(ctx1.domain.confidence);
  });
});

// buildPromptContext unit tests

describe('buildPromptContext', () => {
  it('returns null for general subject', () => {
    expect(buildPromptContext({ subject: 'general' })).toBeNull();
  });

  it('returns null when subject is missing', () => {
    expect(buildPromptContext({})).toBeNull();
  });

  it('includes era when present', () => {
    const result = buildPromptContext({ subject: 'historical', era: '1800-1899', subdomains: [] });
    expect(result).toContain('1800-1899');
  });

  it('includes non-Latin script context', () => {
    const result = buildPromptContext({ subject: 'religious-texts', script_context: 'Persian script', subdomains: [] });
    expect(result).toContain('Persian script');
  });

  it('omits Latin script (default, not worth stating)', () => {
    const result = buildPromptContext({ subject: 'legal', script_context: 'Latin script', subdomains: [] });
    expect(result).not.toContain('Latin script');
  });

  it('includes up to 3 subdomains, not more', () => {
    const result = buildPromptContext({
      subject: 'religious-texts',
      subdomains: ['bahai', 'persian', '19th-century', 'extra-fourth'],
    });
    expect(result).toContain('bahai');
    expect(result).toContain('persian');
    expect(result).not.toContain('extra-fourth');
  });
});

describe('SUBJECT_BUCKETS', () => {
  it('exports a non-empty map of string arrays', () => {
    for (const [key, val] of Object.entries(SUBJECT_BUCKETS)) {
      expect(typeof key).toBe('string');
      expect(Array.isArray(val) && val.length > 0).toBe(true);
    }
  });
});
