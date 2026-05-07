// Tests for identify.js: normalizeLanguageKey pure function. No external tools required.
import { describe, it, expect } from 'vitest';
import { normalizeLanguageKey } from '../../src/pdf-upgrade/identify.js';

describe('normalizeLanguageKey', () => {
  it('returns "unknown" for null', () => {
    expect(normalizeLanguageKey(null)).toBe('unknown');
  });

  it('returns "unknown" for undefined', () => {
    expect(normalizeLanguageKey(undefined)).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(normalizeLanguageKey('')).toBe('unknown');
  });

  it('maps "English" to "english" (case-insensitive)', () => {
    expect(normalizeLanguageKey('English')).toBe('english');
  });

  it('maps "ENGLISH" to "english"', () => {
    expect(normalizeLanguageKey('ENGLISH')).toBe('english');
  });

  it('maps "French" to "french"', () => {
    expect(normalizeLanguageKey('French')).toBe('french');
  });

  it('maps "français" to "french"', () => {
    expect(normalizeLanguageKey('français')).toBe('french');
  });

  it('maps "Spanish" to "spanish"', () => {
    expect(normalizeLanguageKey('Spanish')).toBe('spanish');
  });

  it('maps "español" to "spanish"', () => {
    expect(normalizeLanguageKey('español')).toBe('spanish');
  });

  it('maps "castellano" to "spanish"', () => {
    expect(normalizeLanguageKey('castellano')).toBe('spanish');
  });

  it('maps "German" to "german"', () => {
    expect(normalizeLanguageKey('German')).toBe('german');
  });

  it('maps "Deutsch" to "german"', () => {
    expect(normalizeLanguageKey('Deutsch')).toBe('german');
  });

  it('maps "Arabic" to "arabic"', () => {
    expect(normalizeLanguageKey('Arabic')).toBe('arabic');
  });

  it('maps "Persian" to "persian"', () => {
    expect(normalizeLanguageKey('Persian')).toBe('persian');
  });

  it('maps "Farsi" to "persian"', () => {
    expect(normalizeLanguageKey('Farsi')).toBe('persian');
  });

  it('maps "Hebrew" to "hebrew"', () => {
    expect(normalizeLanguageKey('Hebrew')).toBe('hebrew');
  });

  it('maps "Russian" to "russian"', () => {
    expect(normalizeLanguageKey('Russian')).toBe('russian');
  });

  it('maps "Cyrillic" to "russian"', () => {
    expect(normalizeLanguageKey('Cyrillic')).toBe('russian');
  });

  it('maps "Japanese" to "japanese"', () => {
    expect(normalizeLanguageKey('Japanese')).toBe('japanese');
  });

  it('maps "Chinese" to "chinese"', () => {
    expect(normalizeLanguageKey('Chinese')).toBe('chinese');
  });

  it('maps "Mandarin" to "chinese"', () => {
    expect(normalizeLanguageKey('Mandarin')).toBe('chinese');
  });

  it('returns "unknown" for unrecognized language', () => {
    expect(normalizeLanguageKey('Klingon')).toBe('unknown');
  });

  it('returns "unknown" for numeric string', () => {
    expect(normalizeLanguageKey('12345')).toBe('unknown');
  });

  it('handles partial match: "English (United Kingdom)" maps to "english"', () => {
    expect(normalizeLanguageKey('English (United Kingdom)')).toBe('english');
  });

  it('handles partial match: "Modern Standard Arabic" maps to "arabic"', () => {
    expect(normalizeLanguageKey('Modern Standard Arabic')).toBe('arabic');
  });

  it('handles partial match: "Classical Persian" maps to "persian"', () => {
    expect(normalizeLanguageKey('Classical Persian')).toBe('persian');
  });
});
