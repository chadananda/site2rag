import {describe, it, expect} from 'vitest';
import {detectLanguage, hasTargetLanguage} from '../../../src/utils/language_detector.js';

describe('Language Detector', () => {
  describe('detectLanguage', () => {
    it('should detect language from html lang attribute', () => {
      const html = '<html lang="en-US"><head><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBe('en');
    });

    it('should detect language from html lang attribute case insensitive', () => {
      const html = '<HTML LANG="FR-CA"><head><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBe('fr');
    });

    it('should detect language from meta content-language', () => {
      const html = '<html><head><meta http-equiv="content-language" content="es-MX"><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBe('es');
    });

    it('should detect language from meta name language', () => {
      const html = '<html><head><meta name="language" content="de-DE"><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBe('de');
    });

    it('should detect language from meta name lang', () => {
      const html = '<html><head><meta name="lang" content="it"><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBe('it');
    });

    it('should prefer html lang over meta tags', () => {
      const html = '<html lang="en"><head><meta name="language" content="fr"><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBe('en');
    });

    it('should normalize language codes', () => {
      expect(detectLanguage('<html lang="en-US">')).toBe('en');
      expect(detectLanguage('<html lang="en_GB">')).toBe('en');
      expect(detectLanguage('<html lang="EN">')).toBe('en');
    });

    it('should return null for missing language', () => {
      const html = '<html><head><title>Test</title></head></html>';
      expect(detectLanguage(html)).toBeNull();
    });

    it('should return null for invalid input', () => {
      expect(detectLanguage(null)).toBeNull();
      expect(detectLanguage(undefined)).toBeNull();
      expect(detectLanguage('')).toBeNull();
      expect(detectLanguage(123)).toBeNull();
    });
  });

  describe('hasTargetLanguage', () => {
    it('should return true for matching language', () => {
      const html = '<html lang="en"><head><title>Test</title></head></html>';
      expect(hasTargetLanguage(html, 'en')).toBe(true);
    });

    it('should return false for non-matching language', () => {
      const html = '<html lang="fr"><head><title>Test</title></head></html>';
      expect(hasTargetLanguage(html, 'en')).toBe(false);
    });

    it('should return true when no target language specified', () => {
      const html = '<html lang="fr"><head><title>Test</title></head></html>';
      expect(hasTargetLanguage(html, null)).toBe(true);
      expect(hasTargetLanguage(html, undefined)).toBe(true);
      expect(hasTargetLanguage(html, '')).toBe(true);
    });

    it('should return false when language cannot be detected', () => {
      const html = '<html><head><title>Test</title></head></html>';
      expect(hasTargetLanguage(html, 'en')).toBe(false);
    });

    it('should handle case insensitive comparison', () => {
      const html = '<html lang="EN-US"><head><title>Test</title></head></html>';
      expect(hasTargetLanguage(html, 'en')).toBe(true);
      expect(hasTargetLanguage(html, 'EN')).toBe(true);
    });
  });
});