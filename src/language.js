// Language detection + cost/priority tables. Exports: detectLanguage, detectLanguageFromUrl, detectLanguageFromUrlPath, LANG_COST, LANG_DISPLAY, LANG_PRIORITY, LANG_WORDS

// Common words for Latin-script language discrimination — exported for language-aware scoring
export const LANG_WORDS = {
  french:     new Set(['le','la','les','de','du','des','un','une','et','en','est','que','qui','pas','pour','dans','sur','au','aux','avec','par','ce','cette','ces','il','elle','ils','elles','se','ne','y','ou','mais','si','donc']),
  spanish:    new Set(['el','la','los','las','de','del','un','una','y','en','es','que','por','con','para','su','al','lo','se','no','una','como','más','pero','sus','me','ya','si','sin','sobre','ser','le','ha','muy','todo']),
  german:     new Set(['der','die','das','und','in','ist','zu','den','des','von','mit','dem','ein','eine','auf','für','an','im','als','aber','nach','nicht','auch','bei','werden','durch','noch','wie','wenn','so','oder','um','aus']),
  italian:    new Set(['il','la','le','di','da','del','un','una','e','in','è','che','per','con','non','si','una','ha','ho','ci','mi','lo','gli','suo','loro','dopo','prima','come','ma','se','o','così','anche','lui','lei','sono','era']),
  portuguese: new Set(['o','a','os','as','de','da','do','das','dos','um','uma','e','em','que','por','com','para','seu','sua','não','uma','se','na','no','ao','às','ele','ela','eles','são','foi','ser','ter','mais','mas','ou','já','só','bem']),
  dutch:      new Set(['de','het','een','van','in','is','dat','op','te','en','voor','zijn','niet','met','die','dit','ook','aan','er','maar','heeft','om','dan','als','nog','of','meer','al','wel','bij','ze','hij','zij','wat','zo','door']),
  polish:     new Set(['w','z','i','na','do','się','nie','to','że','a','jak','jest','co','tak','już','ale','o','po','go','mi','jej','ja','on','być','czy','jego','tam','tu','pan','przez','przy','bo','gdy','bo','tym']),
  turkish:    new Set(['bir','bu','ve','da','de','ne','ki','için','ile','gibi','daha','çok','var','yok','olan','hem','ben','sen','o','biz','siz','onlar','ama','veya','ya','ise','ise','de','den','ya']),
};

// Internal aliases for backward compat within this module
const FRENCH_WORDS  = LANG_WORDS.french;
const SPANISH_WORDS = LANG_WORDS.spanish;
const GERMAN_WORDS  = LANG_WORDS.german;
const ITALIAN_WORDS = LANG_WORDS.italian;
const PORTUGUESE_WORDS = LANG_WORDS.portuguese;

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
      const it = sample.filter(w => ITALIAN_WORDS.has(w)).length;
      const pt = sample.filter(w => PORTUGUESE_WORDS.has(w)).length;
      const best = Math.max(fr, es, de, it, pt);
      const threshold = Math.max(3, sample.length * 0.06); // ≥6% function words
      if (best >= threshold) {
        if (fr >= es && fr >= de && fr >= it && fr >= pt) return 'french';
        if (es >= de && es >= it && es >= pt) return 'spanish';
        if (de >= it && de >= pt) return 'german';
        if (it >= pt) return 'italian';
        return 'portuguese';
      }
    }
    return 'english';
  }
  return 'unknown';
};

// ISO code patterns for URL path language detection
const ISO_URL_MAP = [
  ['french',     /\/fr\/|[/_-]fr[/_-]|\/french\/|\/francais\//i],
  ['german',     /\/de\/|[/_-]de[/_-]|\/german\/|\/deutsch\//i],
  ['spanish',    /\/es\/|[/_-]es[/_-]|\/spanish\/|\/espanol\//i],
  ['italian',    /\/it\/|[/_-]it[/_-]|\/italian\/|\/italiano\//i],
  ['portuguese', /\/pt\/|[/_-]pt[/_-]|\/portuguese\/|\/portugues\//i],
  ['dutch',      /\/nl\/|[/_-]nl[/_-]|\/dutch\/|\/nederland\//i],
  ['polish',     /\/pl\/|[/_-]pl[/_-]|\/polish\/|\/polski\//i],
  ['turkish',    /\/tr\/|[/_-]tr[/_-]|\/turkish\/|\/turkce\//i],
  ['korean',     /\/ko\/|[/_-]ko[/_-]|\/korean\//i],
  ['russian',    /\/ru\/|[/_-]ru[/_-]|\/russian\/|\/russki\//i],
];

/**
 * Detect language from URL percent-encoding. Arabic/Persian Unicode block U+0600-U+06FF
 * encodes as %D8xx–%DBxx. Also detects European languages from ISO code path segments.
 */
export const detectLanguageFromUrl = (url) => {
  if (!url) return null;
  // Arabic/Persian block: U+0600–U+06FF → %D8%xx %D9%xx %DA%xx %DB%xx
  if (/%d[89ab]%[0-9a-f]{2}/i.test(url)) {
    // Persian-specific letters: پ(%D9%BE) چ(%DA%86) ژ(%DA%98) ک(%DA%A9) گ(%DA%AF) ی(%DB%8C) ه(%D9%87)
    if (/%(?:d9%(?:be|87)|da%(?:86|98|a9|af)|db%8c)/i.test(url)) return 'persian';
    return 'arabic';
  }
  // Hebrew block: U+0590–U+05FF → %D6%xx %D7%xx
  if (/%d[67]%[0-9a-f]{2}/i.test(url)) return 'hebrew';
  // ISO code path segments for European languages
  for (const [lang, re] of ISO_URL_MAP) {
    if (re.test(url)) return lang;
  }
  return null;
};

/**
 * Detect language from URL path — checks ISO code segments first, then decodes path
 * and runs word-frequency detection on the decoded words.
 */
export const detectLanguageFromUrlPath = (url) => {
  const isoMatch = detectLanguageFromUrl(url);
  if (isoMatch) return isoMatch;
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const words = path.replace(/[^a-zA-ZÀ-ÿ\s]/g, ' ').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length < 2) return null;
    return detectLanguage(words.join(' ')) || null;
  } catch { return null; }
};

// English = 1.0 baseline; non-Latin scripts cost more tokens
export const LANG_COST = {
  english:    1.0,
  french:     1.0,
  spanish:    1.0,
  german:     1.0,
  italian:    1.0,
  portuguese: 1.0,
  dutch:      1.0,
  polish:     1.0,
  turkish:    1.0,
  russian:    1.15,
  unknown:    1.2,
  arabic:     1.35,
  persian:    1.35,
  hebrew:     1.35,
  japanese:   1.5,
  chinese:    1.5,
  korean:     1.5,
};

// Language key → display name (null = no display)
export const LANG_DISPLAY = { english: 'English', french: 'French', spanish: 'Spanish', german: 'German', italian: 'Italian', portuguese: 'Portuguese', dutch: 'Dutch', polish: 'Polish', turkish: 'Turkish', russian: 'Russian', arabic: 'Arabic', persian: 'Persian', hebrew: 'Hebrew', japanese: 'Japanese', chinese: 'Chinese', korean: 'Korean', unknown: null };

// Queue priority multiplier. Non-Latin scripts deeply deprioritized — vision OCR quality unverified.
export const LANG_PRIORITY = {
  english:    1.00,
  french:     1.00,
  spanish:    1.00,
  german:     1.00,
  italian:    1.00,
  portuguese: 1.00,
  dutch:      1.00,
  polish:     1.00,
  turkish:    1.00,
  russian:    0.85,
  arabic:     0.02,
  persian:    0.02,
  hebrew:     0.02,
  japanese:   0.02,
  chinese:    0.02,
  korean:     0.02,
  unknown:    0.30,
};
