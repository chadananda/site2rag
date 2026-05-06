// Language detection + cost/priority tables. Exports: detectLanguage, LANG_COST, LANG_DISPLAY, LANG_PRIORITY

// Common words for Latin-script language discrimination (top 15 per language)
const FRENCH_WORDS  = new Set(['le','la','les','de','du','des','un','une','et','en','est','que','qui','pas','pour','dans','sur','au','aux','avec','par','ce','cette','ces','il','elle','ils','elles','se','ne','y','ou','mais','si','donc']);
const SPANISH_WORDS = new Set(['el','la','los','las','de','del','un','una','y','en','es','que','por','con','para','su','al','lo','se','no','una','como','más','pero','sus','me','ya','si','sin','sobre','ser','le','ha','muy','todo']);
const GERMAN_WORDS  = new Set(['der','die','das','und','in','ist','zu','den','des','von','mit','dem','ein','eine','auf','für','an','im','als','aber','nach','nicht','auch','bei','werden','durch','noch','wie','wenn','so','oder','um','aus']);

/** Detect primary language from Unicode + word-frequency heuristics. Returns lowercase key. */
export const detectLanguage = (text) => {
  if (!text || text.length < 15) return 'unknown';
  const len = text.length;
  if ((text.match(/[\u0600-\u06FF]/g) || []).length / len > 0.07)
    return (text.match(/[\u067E\u0686\u0698\u06AF]/g) || []).length > 0 ? 'persian' : 'arabic';
  if ((text.match(/[\u0590-\u05FF]/g) || []).length / len > 0.07) return 'hebrew';
  if ((text.match(/[\u3040-\u30FF]/g) || []).length / len > 0.05) return 'japanese';
  if ((text.match(/[\u4E00-\u9FFF]/g) || []).length / len > 0.07) return 'chinese';
  if ((text.match(/[\u0400-\u04FF]/g) || []).length / len > 0.07) return 'russian';
  if ((text.match(/[a-zA-Z]/g) || []).length / len > 0.3) {
    // Discriminate Latin-script languages by function-word frequency
    const words = text.toLowerCase().match(/\b[a-zàáâãäåæçèéêëìíîïðñòóôõöùúûüý]{2,}\b/g) || [];
    if (words.length >= 8) {
      const sample = words.slice(0, 150);
      const fr = sample.filter(w => FRENCH_WORDS.has(w)).length;
      const es = sample.filter(w => SPANISH_WORDS.has(w)).length;
      const de = sample.filter(w => GERMAN_WORDS.has(w)).length;
      const best = Math.max(fr, es, de);
      const threshold = Math.max(3, sample.length * 0.06); // ≥6% function words
      if (best >= threshold) {
        if (fr >= es && fr >= de) return 'french';
        if (es >= de) return 'spanish';
        return 'german';
      }
    }
    return 'english';
  }
  return 'unknown';
};

/**
 * Detect language from URL percent-encoding. Arabic/Persian Unicode block U+0600-U+06FF
 * encodes as %D8xx–%DBxx. This catches PDFs whose filenames are in Arabic/Persian script,
 * which is a reliable signal even when the PDF text layer is garbled or missing.
 */
export const detectLanguageFromUrl = (url) => {
  if (!url) return null;
  // Arabic/Persian block: U+0600–U+06FF → %D8xx %D9xx %DAxx %DBxx
  if (!/%(?:d[89ab])[0-9a-f]{2}/i.test(url)) return null;
  // Persian-specific letters: پ(%D9%BE) چ(%DA%86) ژ(%DA%98) ک(%DA%A9) گ(%DA%AF) ی(%DB%8C) ه(%D9%87)
  if (/%(?:d9%(?:be|87)|da%(?:86|98|a9|af)|db%8c)/i.test(url)) return 'persian';
  return 'arabic';
};

// English = 1.0 baseline; non-Latin scripts cost more tokens
export const LANG_COST = {
  english: 1.0,
  french:  1.0,
  spanish: 1.0,
  german:  1.0,
  russian: 1.15,
  unknown: 1.2,
  arabic:  1.35,
  persian: 1.35,
  hebrew:  1.35,
  japanese: 1.5,
  chinese:  1.5,
};

// Language key → display name (null = no display)
export const LANG_DISPLAY = { english: 'English', french: 'French', spanish: 'Spanish', german: 'German', russian: 'Russian', arabic: 'Arabic', persian: 'Persian', hebrew: 'Hebrew', japanese: 'Japanese', chinese: 'Chinese', unknown: null };

// Queue priority multiplier. Non-Latin scripts deeply deprioritized — vision OCR quality unverified.
export const LANG_PRIORITY = {
  english:  1.00,
  french:   1.00,
  spanish:  1.00,
  german:   1.00,
  russian:  0.85,
  arabic:   0.02,
  persian:  0.02,
  hebrew:   0.02,
  japanese: 0.02,
  chinese:  0.02,
  unknown:  0.30,
};
