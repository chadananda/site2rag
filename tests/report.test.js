// Tests for pdf-upgrade/report.js pure helper functions: fmtDuration, scoreColor.
import { describe, it, expect } from 'vitest';
import { fmtDuration, scoreColor } from '../src/pdf-upgrade/report.js';

describe('fmtDuration', () => {
  it('formats 0 seconds as ~0 min', () => {
    expect(fmtDuration(0)).toBe('~0 min');
  });

  it('formats 59 seconds as ~1 min (ceil)', () => {
    expect(fmtDuration(59)).toBe('~1 min');
  });

  it('formats 60 seconds as ~1 min', () => {
    expect(fmtDuration(60)).toBe('~1 min');
  });

  it('formats 3599 seconds as ~60 min (just under 1 hour)', () => {
    expect(fmtDuration(3599)).toBe('~60 min');
  });

  it('formats 3600 seconds as ~1 hr (exactly 1 hour)', () => {
    expect(fmtDuration(3600)).toBe('~1 hr');
  });

  it('formats 7200 seconds as ~2 hr', () => {
    expect(fmtDuration(7200)).toBe('~2 hr');
  });

  it('formats 86399 seconds as ~24 hr (just under 1 day)', () => {
    expect(fmtDuration(86399)).toBe('~24 hr');
  });

  it('formats 86400 seconds as ~1 days (exactly 1 day)', () => {
    expect(fmtDuration(86400)).toBe('~1 days');
  });

  it('formats 172800 seconds as ~2 days', () => {
    expect(fmtDuration(172800)).toBe('~2 days');
  });

  it('formats 604799 seconds as ~7 days (just under 1 week)', () => {
    expect(fmtDuration(604799)).toBe('~7 days');
  });

  it('formats 604800 seconds as ~1 weeks (exactly 1 week)', () => {
    expect(fmtDuration(604800)).toBe('~1 weeks');
  });

  it('formats 1209600 seconds as ~2 weeks', () => {
    expect(fmtDuration(1209600)).toBe('~2 weeks');
  });
});

describe('scoreColor', () => {
  it('returns gray for null score', () => {
    expect(scoreColor(null)).toBe('bg-gray-200 text-gray-500');
  });

  it('returns gray for undefined score', () => {
    expect(scoreColor(undefined)).toBe('bg-gray-200 text-gray-500');
  });

  it('returns green for score >= 0.8', () => {
    expect(scoreColor(0.8)).toBe('bg-green-100 text-green-800');
    expect(scoreColor(1.0)).toBe('bg-green-100 text-green-800');
    expect(scoreColor(0.85)).toBe('bg-green-100 text-green-800');
  });

  it('returns yellow for score >= 0.6 and < 0.8', () => {
    expect(scoreColor(0.6)).toBe('bg-yellow-100 text-yellow-800');
    expect(scoreColor(0.75)).toBe('bg-yellow-100 text-yellow-800');
    expect(scoreColor(0.799)).toBe('bg-yellow-100 text-yellow-800');
  });

  it('returns orange for score >= 0.4 and < 0.6', () => {
    expect(scoreColor(0.4)).toBe('bg-orange-100 text-orange-800');
    expect(scoreColor(0.5)).toBe('bg-orange-100 text-orange-800');
    expect(scoreColor(0.599)).toBe('bg-orange-100 text-orange-800');
  });

  it('returns red for score < 0.4', () => {
    expect(scoreColor(0.0)).toBe('bg-red-100 text-red-800');
    expect(scoreColor(0.1)).toBe('bg-red-100 text-red-800');
    expect(scoreColor(0.399)).toBe('bg-red-100 text-red-800');
  });

  it('boundary: 0.8 is green, 0.799 is yellow', () => {
    expect(scoreColor(0.8)).toContain('green');
    expect(scoreColor(0.799)).toContain('yellow');
  });

  it('boundary: 0.6 is yellow, 0.599 is orange', () => {
    expect(scoreColor(0.6)).toContain('yellow');
    expect(scoreColor(0.599)).toContain('orange');
  });

  it('boundary: 0.4 is orange, 0.399 is red', () => {
    expect(scoreColor(0.4)).toContain('orange');
    expect(scoreColor(0.399)).toContain('red');
  });
});
