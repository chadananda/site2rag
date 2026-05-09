import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testRoot = join(tmpdir(), `site2rag-report-queries-test-${Date.now()}`);
process.env.SITE2RAG_ROOT = testRoot;

import { openDb } from '../src/db.js';
import { siteSummary, siteDocs, siteTabCounts, recentRuns } from '../bin/report-queries.js';

const DOMAIN = 'query.example.com';

describe('siteSummary', () => {
  beforeEach(() => { mkdirSync(join(testRoot, DOMAIN, '_meta'), { recursive: true }); });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns available=false for a domain with no DB', () => {
    const result = siteSummary('nonexistent.domain.com', 'https://nonexistent.domain.com');
    expect(result.available).toBe(false);
    expect(result.domain).toBe('nonexistent.domain.com');
  });

  it('returns available=true with correct domain for existing DB', () => {
    const db = openDb(DOMAIN);
    db.close();
    const result = siteSummary(DOMAIN, `https://${DOMAIN}`);
    expect(result.available).toBe(true);
    expect(result.domain).toBe(DOMAIN);
  });

  it('returns zero counts for empty DB', () => {
    const db = openDb(DOMAIN);
    db.close();
    const result = siteSummary(DOMAIN, `https://${DOMAIN}`);
    expect(result.total_pages).toBe(0);
    expect(result.total_pdfs).toBe(0);
    expect(result.scored).toBe(0);
    expect(result.upgraded).toBe(0);
  });

  it('includes description when provided', () => {
    const db = openDb(DOMAIN);
    db.close();
    const result = siteSummary(DOMAIN, `https://${DOMAIN}`, 'Test description');
    expect(result.description).toBe('Test description');
  });

  it('returns correct total_pages and total_pdfs when data exists', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/page1`, 'page1', 'text/html', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/doc.pdf`, 'doc', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/gone.pdf`, 'gone', 'application/pdf', 1);
    db.close();
    const result = siteSummary(DOMAIN, `https://${DOMAIN}`);
    expect(result.total_pages).toBe(2); // gone excluded
    expect(result.total_pdfs).toBe(1); // only non-gone PDF
  });
});

describe('siteDocs', () => {
  beforeEach(() => { mkdirSync(join(testRoot, DOMAIN, '_meta'), { recursive: true }); });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns null for a domain with no DB', () => {
    const params = new URLSearchParams();
    const result = siteDocs('nonexistent.domain.com', params);
    expect(result).toBeNull();
  });

  it('returns empty docs array for empty DB', () => {
    const db = openDb(DOMAIN);
    db.close();
    const params = new URLSearchParams();
    const result = siteDocs(DOMAIN, params);
    expect(result).not.toBeNull();
    expect(result.docs).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns PDF docs from DB', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/report.pdf`, 'report', 'application/pdf', 0);
    db.close();
    const params = new URLSearchParams();
    const result = siteDocs(DOMAIN, params);
    expect(result.total).toBe(1);
    expect(result.docs[0].url).toContain('report.pdf');
  });

  it('filters by search query', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/annual-report.pdf`, 'annual-report', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/other.pdf`, 'other', 'application/pdf', 0);
    db.close();
    const params = new URLSearchParams({ q: 'annual' });
    const result = siteDocs(DOMAIN, params);
    expect(result.total).toBe(1);
  });

  it('tab=upgraded returns only done/processing docs', () => {
    const db = openDb(DOMAIN);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/upgraded.pdf`, 'upgraded', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/pending.pdf`, 'pending', 'application/pdf', 0);
    db.prepare("INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at) VALUES (?,?,?,?,?)")
      .run(`https://${DOMAIN}/upgraded.pdf`, 'sha256:up', 0.5, 'done', now);
    db.close();
    const result = siteDocs(DOMAIN, new URLSearchParams({ tab: 'upgraded' }));
    expect(result.total).toBe(1);
    expect(result.docs[0].url).toContain('upgraded.pdf');
  });

  it('status=skipped filters to skip=1 docs', () => {
    const db = openDb(DOMAIN);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/skipped.pdf`, 'skipped', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/normal.pdf`, 'normal', 'application/pdf', 0);
    db.prepare("INSERT INTO pdf_quality (url, content_hash, scored_at, composite_score, has_text_layer, pages, skip) VALUES (?,?,?,?,?,?,?)")
      .run(`https://${DOMAIN}/skipped.pdf`, 'sha256:s', now, 0.9, 1, 5, 1);
    db.close();
    const result = siteDocs(DOMAIN, new URLSearchParams({ status: 'skipped' }));
    expect(result.total).toBe(1);
    expect(result.docs[0].url).toContain('skipped.pdf');
  });

  it('status=unscored filters to docs with no composite_score', () => {
    const db = openDb(DOMAIN);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/scored.pdf`, 'scored', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/unscored.pdf`, 'unscored', 'application/pdf', 0);
    db.prepare("INSERT INTO pdf_quality (url, content_hash, scored_at, composite_score, has_text_layer, pages) VALUES (?,?,?,?,?,?)")
      .run(`https://${DOMAIN}/scored.pdf`, 'sha256:sc', now, 0.7, 1, 3);
    db.close();
    const result = siteDocs(DOMAIN, new URLSearchParams({ status: 'unscored' }));
    expect(result.total).toBe(1);
    expect(result.docs[0].url).toContain('unscored.pdf');
  });

  it('score_max filters out high-score docs', () => {
    const db = openDb(DOMAIN);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/low.pdf`, 'low', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/high.pdf`, 'high', 'application/pdf', 0);
    db.prepare("INSERT INTO pdf_quality (url, content_hash, scored_at, composite_score, has_text_layer, pages) VALUES (?,?,?,?,?,?)")
      .run(`https://${DOMAIN}/low.pdf`, 'sha256:low', now, 0.3, 0, 5);
    db.prepare("INSERT INTO pdf_quality (url, content_hash, scored_at, composite_score, has_text_layer, pages) VALUES (?,?,?,?,?,?)")
      .run(`https://${DOMAIN}/high.pdf`, 'sha256:high', now, 0.9, 1, 5);
    db.close();
    const result = siteDocs(DOMAIN, new URLSearchParams({ score_max: '0.5' }));
    expect(result.docs.every(d => !d.url.includes('high.pdf'))).toBe(true);
    expect(result.docs.some(d => d.url.includes('low.pdf'))).toBe(true);
  });

  it('pagination returns correct page and total', () => {
    const db = openDb(DOMAIN);
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
        .run(`https://${DOMAIN}/doc${i}.pdf`, `doc${i}`, 'application/pdf', 0);
    }
    db.close();
    const result = siteDocs(DOMAIN, new URLSearchParams({ page: '1' }));
    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.docs).toHaveLength(5);
  });
});

describe('siteTabCounts', () => {
  beforeEach(() => { mkdirSync(join(testRoot, DOMAIN, '_meta'), { recursive: true }); });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns null for a domain with no DB', () => {
    expect(siteTabCounts('nonexistent.domain.com')).toBeNull();
  });

  it('returns zero counts for empty DB', () => {
    const db = openDb(DOMAIN);
    db.close();
    const result = siteTabCounts(DOMAIN);
    expect(result).not.toBeNull();
    expect(result.original).toBe(0);
    expect(result.upgraded).toBe(0);
  });

  it('counts PDFs correctly', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/doc.pdf`, 'doc', 'application/pdf', 0);
    db.close();
    const result = siteTabCounts(DOMAIN);
    expect(result.original).toBe(1);
    expect(result.upgraded).toBe(0);
  });

  it('counts upgraded (done) separately from total', () => {
    const db = openDb(DOMAIN);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/a.pdf`, 'a', 'application/pdf', 0);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/b.pdf`, 'b', 'application/pdf', 0);
    db.prepare("INSERT INTO pdf_upgrade_queue (url, content_hash, priority, status, queued_at) VALUES (?,?,?,?,?)")
      .run(`https://${DOMAIN}/a.pdf`, 'sha256:a', 0.5, 'done', now);
    db.close();
    const result = siteTabCounts(DOMAIN);
    expect(result.original).toBe(2);
    expect(result.upgraded).toBe(1);
  });

  it('excludes gone PDFs from counts', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO pages (url, path_slug, mime_type, gone) VALUES (?,?,?,?)")
      .run(`https://${DOMAIN}/gone.pdf`, 'gone', 'application/pdf', 1);
    db.close();
    const result = siteTabCounts(DOMAIN);
    expect(result.original).toBe(0);
  });
});

describe('recentRuns', () => {
  beforeEach(() => { mkdirSync(join(testRoot, DOMAIN, '_meta'), { recursive: true }); });
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it('returns empty array when no sites have DBs', () => {
    const result = recentRuns([{ domain: 'nonexistent.domain.com' }]);
    expect(result).toEqual([]);
  });

  it('returns runs from existing DB', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO runs (started_at, status) VALUES (?,?)").run(new Date().toISOString(), 'success');
    db.close();
    const result = recentRuns([{ domain: DOMAIN }]);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].domain).toBe(DOMAIN);
  });

  it('sorts runs newest first', () => {
    const db = openDb(DOMAIN);
    db.prepare("INSERT INTO runs (started_at, status) VALUES (?,?)").run('2024-01-01T00:00:00Z', 'success');
    db.prepare("INSERT INTO runs (started_at, status) VALUES (?,?)").run('2024-06-01T00:00:00Z', 'success');
    db.close();
    const result = recentRuns([{ domain: DOMAIN }]);
    expect(result[0].started_at).toContain('2024-06-01');
  });
});
