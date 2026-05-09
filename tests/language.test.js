import { describe, it, expect } from 'vitest';
import { detectLanguage, detectLanguageFromUrl, detectLanguageFromUrlPath, LANG_COST, LANG_DISPLAY, LANG_PRIORITY, LANG_WORDS } from '../src/language.js';

describe('detectLanguage', () => {
  it('returns unknown for null/empty text', () => {
    expect(detectLanguage(null)).toBe('unknown');
    expect(detectLanguage('')).toBe('unknown');
    expect(detectLanguage('short')).toBe('unknown');
  });

  it('detects Arabic from Arabic script characters', () => {
    const arabic = 'هذا نص عربي طويل بما فيه الكفاية للكشف عن اللغة العربية في النص'.repeat(3);
    expect(detectLanguage(arabic)).toBe('arabic');
  });

  it('detects Persian from Persian-specific characters', () => {
    // پ ژ گ are Persian-specific chars (not in Arabic)
    const persian = 'این یک متن فارسی است که شامل حروف پ و گ و ژ می باشد و باید شناسایی شود'.repeat(3);
    expect(detectLanguage(persian)).toBe('persian');
  });

  it('detects Hebrew from Hebrew script characters', () => {
    const hebrew = 'זהו טקסט בעברית שצריך להיות מזוהה כשפה עברית על ידי הפונקציה'.repeat(3);
    expect(detectLanguage(hebrew)).toBe('hebrew');
  });

  it('detects Japanese from hiragana/katakana characters', () => {
    const japanese = 'これは日本語のテキストです。言語検出機能によって日本語として識別される必要があります。'.repeat(3);
    expect(detectLanguage(japanese)).toBe('japanese');
  });

  it('detects Chinese from CJK unified ideographs', () => {
    const chinese = '这是一段中文文本，应该被语言检测功能识别为中文语言，包含足够多的汉字字符以触发阈值。'.repeat(3);
    expect(detectLanguage(chinese)).toBe('chinese');
  });

  it('detects Russian from Cyrillic characters', () => {
    const russian = 'Это русский текст который должен быть определён как русский язык функцией обнаружения языка'.repeat(3);
    expect(detectLanguage(russian)).toBe('russian');
  });

  it('detects English as default for Latin-script text without strong signals', () => {
    const english = 'The quick brown fox jumps over the lazy dog. This is a simple English sentence that should be detected.';
    expect(detectLanguage(english)).toBe('english');
  });

  it('detects French from high frequency of French function words', () => {
    const french = 'Le chat est dans la maison et les enfants jouent avec les jouets dans le jardin du parc avec des amis qui ne sont pas là pour les voir faire des choses amusantes.';
    expect(detectLanguage(french)).toBe('french');
  });

  it('detects Spanish from high frequency of Spanish function words', () => {
    const spanish = 'El perro está en la casa y los niños juegan con los juguetes en el jardín del parque con sus amigos que no están allí para verlos hacer las cosas divertidas de las que hablan.';
    expect(detectLanguage(spanish)).toBe('spanish');
  });

  it('detects German from high frequency of German function words', () => {
    const german = 'Der Hund ist in dem Haus und die Kinder spielen mit den Spielsachen im Garten des Parks mit den Freunden die nicht da sind um sie die lustigen Dinge machen zu sehen die sie beschreiben.';
    expect(detectLanguage(german)).toBe('german');
  });

  it('returns unknown for text that is too short (< 15 chars)', () => {
    expect(detectLanguage('hello world')).toBe('unknown');
  });

  it('detects Italian from high frequency of Italian function words', () => {
    const italian = 'Il gatto è nella casa e i bambini giocano con i giocattoli nel giardino del parco con gli amici che non ci sono per vederli fare le cose divertenti di cui parlano dopo.';
    expect(detectLanguage(italian)).toBe('italian');
  });

  it('detects Portuguese from high frequency of Portuguese function words', () => {
    const portuguese = 'O gato está na casa e as crianças brincam com os brinquedos no jardim do parque com os amigos que não estão lá para vê-los fazer as coisas divertidas de que falam depois.';
    expect(detectLanguage(portuguese)).toBe('portuguese');
  });
});

describe('detectLanguageFromUrl', () => {
  it('returns null for null/empty URL', () => {
    expect(detectLanguageFromUrl(null)).toBeNull();
    expect(detectLanguageFromUrl('')).toBeNull();
  });

  it('detects Arabic from percent-encoded Arabic characters', () => {
    // Arabic chars encode to %D8xx-%DBxx
    const url = 'https://example.com/%D9%85%D8%B1%D8%AD%D8%A8%D8%A7/doc.pdf';
    expect(detectLanguageFromUrl(url)).toBe('arabic');
  });

  it('detects Persian from Persian-specific percent-encoded characters', () => {
    // Persian گ = %DA%AF
    const url = 'https://example.com/%DA%AF%D9%81%D8%AA%DA%AF%D9%88/doc.pdf';
    expect(detectLanguageFromUrl(url)).toBe('persian');
  });

  it('detects Hebrew from percent-encoded Hebrew characters', () => {
    // Hebrew chars encode to %D6xx-%D7xx
    const url = 'https://example.com/%D7%A9%D7%9C%D7%95%D7%9D/doc.pdf';
    expect(detectLanguageFromUrl(url)).toBe('hebrew');
  });

  it('detects French from /fr/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/fr/about')).toBe('french');
  });

  it('detects German from /de/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/de/ueber-uns')).toBe('german');
  });

  it('detects Spanish from /es/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/es/acerca')).toBe('spanish');
  });

  it('detects Russian from /ru/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/ru/about')).toBe('russian');
  });

  it('detects Turkish from /tr/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/tr/hakkimizda')).toBe('turkish');
  });

  it('detects Korean from /ko/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/ko/about')).toBe('korean');
  });

  it('detects Italian from /it/ path segment', () => {
    expect(detectLanguageFromUrl('https://example.com/it/chi-siamo')).toBe('italian');
  });

  it('returns null for plain English URL with no ISO path', () => {
    expect(detectLanguageFromUrl('https://example.com/about/us')).toBeNull();
  });
});

describe('detectLanguageFromUrlPath', () => {
  it('returns null for null URL', () => {
    expect(detectLanguageFromUrlPath(null)).toBeNull();
  });

  it('uses ISO detection first (fr path segment)', () => {
    expect(detectLanguageFromUrlPath('https://example.com/fr/report.pdf')).toBe('french');
  });

  it('returns null for short decoded path with too few words', () => {
    expect(detectLanguageFromUrlPath('https://example.com/a/b')).toBeNull();
  });

  it('handles malformed URL without throwing', () => {
    expect(() => detectLanguageFromUrlPath('not-a-valid-url')).not.toThrow();
  });
});

describe('LANG_COST', () => {
  it('English has cost 1.0', () => {
    expect(LANG_COST.english).toBe(1.0);
  });

  it('Arabic costs more than English', () => {
    expect(LANG_COST.arabic).toBeGreaterThan(LANG_COST.english);
  });

  it('Japanese/Chinese/Korean have highest cost (1.5)', () => {
    expect(LANG_COST.japanese).toBe(1.5);
    expect(LANG_COST.chinese).toBe(1.5);
    expect(LANG_COST.korean).toBe(1.5);
  });
});

describe('LANG_PRIORITY', () => {
  it('English has priority 1.0', () => {
    expect(LANG_PRIORITY.english).toBe(1.0);
  });

  it('Arabic/Persian/Hebrew have very low priority (~0.02)', () => {
    expect(LANG_PRIORITY.arabic).toBeLessThan(0.1);
    expect(LANG_PRIORITY.persian).toBeLessThan(0.1);
    expect(LANG_PRIORITY.hebrew).toBeLessThan(0.1);
  });

  it('unknown has intermediate priority', () => {
    expect(LANG_PRIORITY.unknown).toBeGreaterThan(LANG_PRIORITY.arabic);
    expect(LANG_PRIORITY.unknown).toBeLessThan(LANG_PRIORITY.english);
  });
});

describe('LANG_WORDS', () => {
  it('exports word sets for major languages', () => {
    expect(LANG_WORDS.french).toBeInstanceOf(Set);
    expect(LANG_WORDS.spanish).toBeInstanceOf(Set);
    expect(LANG_WORDS.german).toBeInstanceOf(Set);
  });

  it('French set contains common French function words', () => {
    expect(LANG_WORDS.french.has('le')).toBe(true);
    expect(LANG_WORDS.french.has('les')).toBe(true);
    expect(LANG_WORDS.french.has('est')).toBe(true);
  });
});

describe('LANG_DISPLAY', () => {
  it('English maps to display name "English"', () => {
    expect(LANG_DISPLAY.english).toBe('English');
  });

  it('unknown maps to null (no display name)', () => {
    expect(LANG_DISPLAY.unknown).toBeNull();
  });

  it('Arabic and Persian have display names', () => {
    expect(LANG_DISPLAY.arabic).toBe('Arabic');
    expect(LANG_DISPLAY.persian).toBe('Persian');
  });
});

describe('detectLanguageFromUrlPath (word-frequency branch)', () => {
  it('detects French from path words when no ISO segment present', () => {
    // No /fr/ segment — path words must trigger word-frequency detection
    const url = 'https://example.com/les-enfants-jouent-dans-le-jardin-avec-des-amis-et-des-jouets';
    expect(detectLanguageFromUrlPath(url)).toBe('french');
  });
});
