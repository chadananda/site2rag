// Language detection + cost/priority tables. Exports: detectLanguage, LANG_COST, LANG_DISPLAY, LANG_PRIORITY

/** Detect primary language from Unicode composition of a text sample. Returns lowercase key. */
export const detectLanguage = (text) => {
  if (!text || text.length < 15) return 'unknown';
  const len = text.length;
  if ((text.match(/[\u0600-\u06FF]/g) || []).length / len > 0.07)
    return (text.match(/[\u067E\u0686\u0698\u06AF]/g) || []).length > 0 ? 'persian' : 'arabic';
  if ((text.match(/[\u0590-\u05FF]/g) || []).length / len > 0.07) return 'hebrew';
  if ((text.match(/[\u3040-\u30FF]/g) || []).length / len > 0.05) return 'japanese';
  if ((text.match(/[\u4E00-\u9FFF]/g) || []).length / len > 0.07) return 'chinese';
  if ((text.match(/[\u0400-\u04FF]/g) || []).length / len > 0.07) return 'russian';
  if ((text.match(/[a-zA-Z]/g) || []).length / len > 0.3) return 'english';
  return 'unknown';
};

// English = 1.0 baseline; non-Latin scripts cost more tokens
export const LANG_COST = {
  english: 1.0,
  russian: 1.15,
  unknown: 1.2,
  arabic:  1.35,
  persian: 1.35,
  hebrew:  1.35,
  japanese: 1.5,
  chinese:  1.5,
};

// Language key → display name (null = no display)
export const LANG_DISPLAY = { english: 'English', russian: 'Russian', arabic: 'Arabic', persian: 'Persian', hebrew: 'Hebrew', japanese: 'Japanese', chinese: 'Chinese', unknown: null };

// Queue priority multiplier; unknown deprioritized until cheap scan identifies language
export const LANG_PRIORITY = {
  english:  1.00,
  russian:  0.85,
  arabic:   0.70,
  persian:  0.70,
  hebrew:   0.70,
  japanese: 0.55,
  chinese:  0.55,
  unknown:  0.30,
};
