// Language-to-pipeline config mappings derived from Sessions 1-16 optimizer results.
// Import getPipelineConfig(langStr, isImagePdf) to get the optimal config object.
// Exports: getPipelineConfig, LANG_ALIASES
// Deps: none

// Normalize varied language strings to canonical codes
export const LANG_ALIASES = {
  arabic: 'arabic', ar: 'arabic', ara: 'arabic',
  persian: 'persian', farsi: 'persian', fa: 'persian', fas: 'persian',
  french: 'french', fr: 'french', fra: 'french',
  english: 'english', en: 'english', eng: 'english',
  german: 'german', de: 'german', deu: 'german',
};

// Optimal pipeline configs per language (image PDFs only — text PDFs use defaults)
const IMAGE_PDF_CONFIGS = {
  arabic:  { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'ara', s3MultiEngine: ['surya'] },
  persian: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku', s3Lang: 'fas', s3MultiEngine: ['surya'] },
  french:  { skip: ['s2','s3','s4','s7','s8'], s5Mode: 'haiku' },
  default: { skip: ['s2','s4','s7','s8'], s5Mode: 'haiku' },
};

export function getPipelineConfig(langStr, isImagePdf) {
  if (!isImagePdf) return {};
  const canonical = LANG_ALIASES[(langStr ?? '').toLowerCase()] ?? 'default';
  return IMAGE_PDF_CONFIGS[canonical] ?? IMAGE_PDF_CONFIGS.default;
}
