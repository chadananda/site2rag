// Tests for language.js: detectLanguage, detectLanguageFromUrl, detectLanguageFromUrlPath.
import { describe, it, expect } from 'vitest';
import { detectLanguage, detectLanguageFromUrl, detectLanguageFromUrlPath, LANG_COST, LANG_PRIORITY, LANG_DISPLAY } from '../../src/language.js';

describe('detectLanguage', () => {
  it('returns "unknown" for null', () => {
    expect(detectLanguage(null)).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(detectLanguage('')).toBe('unknown');
  });

  it('returns "unknown" for very short text', () => {
    expect(detectLanguage('hi')).toBe('unknown');
  });

  it('detects arabic from Arabic script characters', () => {
    // Arabic text: Quran opening
    const arabic = 'بسم الله الرحمن الرحيم الحمد لله رب العالمين الرحمن الرحيم';
    expect(detectLanguage(arabic)).toBe('arabic');
  });

  it('detects persian from Persian-specific letters (پ چ ژ گ)', () => {
    // Must include پ (U+067E), چ (U+0686), ژ (U+0698), or گ (U+06AF) to distinguish from Arabic
    const persian = 'پاسخ چرا گاهی ژرف است که باید آن را بیابیم و پیدا کنیم';
    expect(detectLanguage(persian)).toBe('persian');
  });

  it('detects russian from Cyrillic characters', () => {
    const russian = 'Это русский текст для проверки определения языка документа';
    expect(detectLanguage(russian)).toBe('russian');
  });

  it('detects french from function words', () => {
    const french = 'Le livre que je lis est très intéressant. Il y a beaucoup de pages dans ce livre pour les enfants de notre pays.';
    expect(detectLanguage(french)).toBe('french');
  });

  it('detects german from function words', () => {
    const german = 'Das Buch, das ich lese, ist sehr interessant. Es gibt viele Seiten in diesem Buch für die Kinder unseres Landes.';
    expect(detectLanguage(german)).toBe('german');
  });

  it('detects spanish from function words', () => {
    const spanish = 'El libro que leo es muy interesante. Hay muchas páginas en este libro para los niños de nuestro país con su familia.';
    expect(detectLanguage(spanish)).toBe('spanish');
  });

  it('detects italian from function words', () => {
    const italian = 'Il libro che leggo è molto interessante. Non si può leggere tutto in un giorno solo con la sua famiglia.';
    expect(detectLanguage(italian)).toBe('italian');
  });

  it('detects portuguese from function words', () => {
    const portuguese = 'O livro que leio é muito interessante. Não se pode ler tudo em um dia só com a sua família em casa.';
    expect(detectLanguage(portuguese)).toBe('portuguese');
  });

  it('returns "english" for English text', () => {
    const english = 'The quick brown fox jumps over the lazy dog. This is an example of standard English text for testing purposes.';
    expect(detectLanguage(english)).toBe('english');
  });

  it('detects japanese from Hiragana/Katakana', () => {
    const japanese = 'これは日本語のテキストです。テスト用のサンプルです。';
    expect(detectLanguage(japanese)).toBe('japanese');
  });

  it('detects chinese from CJK characters', () => {
    const chinese = '这是中文文本。我们正在测试语言检测功能是否正常工作。';
    expect(detectLanguage(chinese)).toBe('chinese');
  });

  it('detects hebrew from Hebrew script', () => {
    const hebrew = 'זהו טקסט עברי לבדיקת זיהוי השפה. יש הרבה מילים עבריות כאן.';
    expect(detectLanguage(hebrew)).toBe('hebrew');
  });
});

describe('detectLanguageFromUrl', () => {
  it('returns null for null input', () => {
    expect(detectLanguageFromUrl(null)).toBeNull();
  });

  it('detects arabic from percent-encoded Arabic chars in URL (%D8%xx format)', () => {
    // Arabic: %D8%A8%D8%B3%D9%85 = بسم
    const url = 'https://example.com/pdf/%D8%A8%D8%B3%D9%85.pdf';
    expect(detectLanguageFromUrl(url)).toBe('arabic');
  });

  it('detects persian from percent-encoded Persian chars (%DA%A9 = ک)', () => {
    // ک = %DA%A9 is a Persian-specific letter
    const url = 'https://bahai-library.com/pdf/%DA%A9%D8%AA%D8%A7%D8%A8.pdf';
    expect(detectLanguageFromUrl(url)).toBe('persian');
  });

  it('detects french from /fr/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/fr/document.pdf')).toBe('french');
  });

  it('detects german from /de/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/de/dokument.pdf')).toBe('german');
  });

  it('detects spanish from /es/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/es/documento.pdf')).toBe('spanish');
  });

  it('detects russian from /ru/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/ru/document.pdf')).toBe('russian');
  });

  it('detects italian from /it/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/it/documento.pdf')).toBe('italian');
  });

  it('detects portuguese from /pt/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/pt/documento.pdf')).toBe('portuguese');
  });

  it('returns null for plain English URL', () => {
    expect(detectLanguageFromUrl('https://example.com/documents/report.pdf')).toBeNull();
  });

  it('detects hebrew from percent-encoded Hebrew chars (%D7%xx format)', () => {
    // שלום = %D7%A9%D7%9C%D7%95%D7%9D
    const url = 'https://example.com/%D7%A9%D7%9C%D7%95%D7%9D.pdf';
    expect(detectLanguageFromUrl(url)).toBe('hebrew');
  });

  it('detects dutch from /nl/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/nl/document.pdf')).toBe('dutch');
  });

  it('detects polish from /pl/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/pl/dokument.pdf')).toBe('polish');
  });

  it('detects turkish from /tr/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/tr/belge.pdf')).toBe('turkish');
  });

  it('detects korean from /ko/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/ko/document.pdf')).toBe('korean');
  });
});

describe('detectLanguageFromUrlPath', () => {
  it('returns null for null', () => {
    expect(detectLanguageFromUrlPath(null)).toBeNull();
  });

  it('delegates to detectLanguageFromUrl first (ISO code)', () => {
    expect(detectLanguageFromUrlPath('https://example.com/fr/doc.pdf')).toBe('french');
  });

  it('delegates to detectLanguageFromUrl for Arabic percent-encoded URL', () => {
    const url = 'https://example.com/%D8%A8%D8%B3%D9%85.pdf';
    expect(detectLanguageFromUrlPath(url)).toBe('arabic');
  });

  it('returns null for short decoded path with too few words', () => {
    expect(detectLanguageFromUrlPath('https://example.com/a.pdf')).toBeNull();
  });

  it('detects french from decoded French words in path (word-frequency fallback)', () => {
    // No ISO code; URL decoded path has enough French function words (les, dans, pour) for detection
    // Note: avoid '-de-' in path as that falsely matches the German ISO pattern [/_-]de[/_-]
    const url = 'https://example.com/les-jardins-dans-le-monde-pour-les-enfants.pdf';
    expect(detectLanguageFromUrlPath(url)).toBe('french');
  });

  it('returns null for invalid/unparsable URL', () => {
    expect(detectLanguageFromUrlPath('not a url at all')).toBeNull();
  });
});

describe('LANG_COST', () => {
  it('English costs 1.0', () => {
    expect(LANG_COST.english).toBe(1.0);
  });

  it('Arabic costs more than English', () => {
    expect(LANG_COST.arabic).toBeGreaterThan(LANG_COST.english);
  });

  it('Chinese/Japanese cost the most', () => {
    expect(LANG_COST.chinese).toBeGreaterThanOrEqual(LANG_COST.arabic);
    expect(LANG_COST.japanese).toBeGreaterThanOrEqual(LANG_COST.arabic);
  });
});

describe('LANG_DISPLAY', () => {
  it('English has display name', () => {
    expect(LANG_DISPLAY.english).toBe('English');
  });

  it('unknown returns null', () => {
    expect(LANG_DISPLAY.unknown).toBeNull();
  });
});

describe('LANG_PRIORITY', () => {
  it('is defined and has english key', () => {
    expect(typeof LANG_PRIORITY.english).toBe('number');
  });

  it('non-Latin scripts have lower priority than Latin', () => {
    expect(LANG_PRIORITY.arabic).toBeLessThan(LANG_PRIORITY.english);
  });
});
