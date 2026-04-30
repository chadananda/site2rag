// Rules engine -- compiles and applies per-site rules block. Pure data; deterministic.
/** Compile a rules block from site config into pre-compiled RegExp patterns. */
export const compileRules = (rules = {}) => ({
  content_selector: rules.content_selector || null,
  exclude_selectors: rules.exclude_selectors || [],
  title_selector: rules.title_selector || null,
  date_selector: rules.date_selector || null,
  classify_overrides: (rules.classify_overrides || []).map(o => ({ pattern: new RegExp(o.pattern), role: o.role })),
  ocr_overrides: (rules.ocr_overrides || []).map(o => ({ pattern: new RegExp(o.pattern), config: o })),
  follow_overrides: (rules.follow_overrides || []).map(o => ({ pattern: new RegExp(o.pattern), follow: o.follow })),
  canonical_strip_query: rules.canonical_strip_query || []
});
/** Apply classify_overrides to URL. Returns role string or null. */
export const applyClassifyOverride = (compiled, url) => {
  const match = compiled.classify_overrides.find(o => o.pattern.test(url));
  return match ? match.role : null;
};
/** Apply follow_overrides to URL. Returns boolean or null (no override). */
export const applyFollowOverride = (compiled, url) => {
  const match = compiled.follow_overrides.find(o => o.pattern.test(url));
  return match ? match.follow : null;
};
/** Apply ocr_overrides to URL. Returns override config object or null. */
export const applyOcrOverride = (compiled, url) => {
  const match = compiled.ocr_overrides.find(o => o.pattern.test(url));
  return match ? match.config : null;
};
/** Strip canonical query params per rules. */
export const stripQueryParams = (compiled, urlStr) => {
  if (!compiled.canonical_strip_query.length) return urlStr;
  const u = new URL(urlStr);
  compiled.canonical_strip_query.forEach(p => u.searchParams.delete(p));
  return u.toString();
};
