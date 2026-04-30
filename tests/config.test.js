import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeSiteConfig } from '../src/config.js';
describe('mergeSiteConfig', () => {
  it('merges site keys over defaults', () => {
    const defaults = { check_every_days: 3, max_depth: 8, sitemap: { enabled: true, diff_every_hours: 24 } };
    const site = { domain: 'example.com', check_every_days: 7 };
    const merged = mergeSiteConfig(defaults, site);
    expect(merged.check_every_days).toBe(7);
    expect(merged.max_depth).toBe(8);
    expect(merged.domain).toBe('example.com');
  });
  it('deep merges nested objects', () => {
    const defaults = { sitemap: { enabled: true, diff_every_hours: 24, fallback_to_crawl: true } };
    const site = { sitemap: { diff_every_hours: 48 } };
    const merged = mergeSiteConfig(defaults, site);
    expect(merged.sitemap.enabled).toBe(true);
    expect(merged.sitemap.diff_every_hours).toBe(48);
    expect(merged.sitemap.fallback_to_crawl).toBe(true);
  });
  it('arrays replace not concat', () => {
    const defaults = { ocr: { engines: ['tesseract'] } };
    const site = { ocr: { engines: ['mistral', 'claude'] } };
    const merged = mergeSiteConfig(defaults, site);
    expect(merged.ocr.engines).toEqual(['mistral', 'claude']);
  });
});
