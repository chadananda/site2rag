// Config loader -- reads websites.yaml, merges per-site keys over defaults, resolves SITE2RAG_ROOT.
// Path helpers are lazy (read env at call time) for test isolation with ESM module hoisting.
// Auto-loads APP_DIR/.env on import so API keys are available without manual shell export.
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import yaml from 'js-yaml';
export const APP_DIR = resolve(import.meta.dirname, '..');

// Load .env from project root if present — sets process.env for all subsequent imports.
// Skips keys already set (shell export wins over .env).
const envPath = join(APP_DIR, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=["']?([^"'\n]*)["']?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
/** Lazy root -- reads process.env at call time so tests can set SITE2RAG_ROOT after module load. */
export const getSiteRoot = () => process.env.SITE2RAG_ROOT || resolve(import.meta.dirname, '../..');
/** Return mirror root dir. */
export const getMirrorRoot = () => join(getSiteRoot(), 'websites_mirror');
/** Return MD output root dir. */
export const getMdRoot = () => join(getSiteRoot(), 'websites_md');
/** Return logs root dir. */
export const getLogsRoot = () => join(getSiteRoot(), 'logs');
/** Return tmp dir for pipeline operations — always on the data drive, never the OS drive. */
export const getTmpDir = () => join(getSiteRoot(), 'tmp');
/** Return mirror path for a domain. */
export const mirrorDir = (domain) => join(getMirrorRoot(), domain);
/** Return MD output dir for a domain. */
export const mdDir = (domain) => join(getMdRoot(), domain);
/** Return _meta dir for a domain's mirror. */
export const metaDir = (domain) => join(getMirrorRoot(), domain, '_meta');
/** Return _assets dir for a domain's mirror. */
export const assetsDir = (domain) => join(getMirrorRoot(), domain, '_assets');
/** Load and parse websites.yaml from SITE2RAG_ROOT. */
export const loadYaml = () => {
  const yamlPath = join(getSiteRoot(), 'websites.yaml');
  if (!existsSync(yamlPath)) throw new Error(`websites.yaml not found at ${yamlPath}`);
  return yaml.load(readFileSync(yamlPath, 'utf8'));
};
/** Deep merge: target keys win over source (defaults). Arrays replace, not concat. */
export const deepMerge = (source, target) => {
  if (!target || typeof target !== 'object') return target ?? source;
  if (!source || typeof source !== 'object') return target;
  const result = { ...source };
  for (const key of Object.keys(target)) {
    result[key] = (target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key]))
      ? deepMerge(source[key] ?? {}, target[key])
      : target[key];
  }
  return result;
};
/** Return fully-merged config for a site entry, with defaults applied. */
export const mergeSiteConfig = (defaults, site) => deepMerge(defaults, site);
/** Load config and return { defaults, sites[] } where each site is fully merged. */
export const loadConfig = () => {
  const raw = loadYaml();
  const defaults = raw.defaults || {};
  const sites = (raw.sites || []).map(s => mergeSiteConfig(defaults, s));
  return { defaults, sites, version: raw.version };
};
