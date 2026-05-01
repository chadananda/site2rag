// Report generator -- reads all site DBs, builds static HTML dashboard, writes to REPORT_PATH.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getMirrorRoot, getSiteRoot } from '../config.js';
import { openDb } from '../db.js';
const REPORT_PATH = process.env.UPGRADE_REPORT_PATH || join(getSiteRoot(), 'report');
/** Gather all data from a site's DB. */
const gatherSiteData = (domain) => {
  const dbPath = join(getMirrorRoot(), domain, '_meta', 'site.sqlite');
  if (!existsSync(dbPath)) return null;
  let db;
  try { db = openDb(domain); } catch { return null; }
  try {
    const rows = db.prepare(`
      SELECT p.url, p.path_slug, p.local_path, p.content_hash, p.last_seen_at,
             q.composite_score, q.avg_chars_per_page, q.readable_pages_pct,
             q.has_text_layer, q.word_quality_estimate, q.pages, q.scored_at,
             u.status, u.priority, u.queued_at, u.started_at, u.finished_at,
             u.upgraded_pdf_path, u.before_score, u.after_score,
             u.score_improvement, u.pages_processed, u.method, u.error,
             e.md_path,
             h.hosted_title as title
      FROM pages p
      LEFT JOIN pdf_quality q ON p.url = q.url
      LEFT JOIN pdf_upgrade_queue u ON p.url = u.url
      LEFT JOIN exports e ON p.url = e.url
      LEFT JOIN hosts h ON p.url = h.hosted_url
      WHERE p.gone = 0 AND p.mime_type = 'application/pdf'
      ORDER BY COALESCE(q.composite_score, 1) ASC
    `).all();
    // Add archive_url: the lnker.com URL where the upgraded PDF can be downloaded
    const docs = rows.map(d => {
      let archive_url = null;
      if (d.status === 'done' && d.upgraded_pdf_path) {
        const slug = d.path_slug || (d.url.replace(/[^a-z0-9]/gi, '_').slice(-60));
        archive_url = `https://${domain}.lnker.com/_upgraded/${slug}.pdf`;
      }
      return { ...d, archive_url };
    });
    const totalDocs = docs.length;
    const scored = docs.filter(d => d.composite_score !== null).length;
    const upgraded = docs.filter(d => d.status === 'done').length;
    const pending = docs.filter(d => d.status === 'pending' || (!d.status && d.composite_score !== null)).length;
    const processing = docs.filter(d => d.status === 'processing').length;
    const failed = docs.filter(d => d.status === 'failed').length;
    const avgImprovement = docs.filter(d => d.score_improvement).reduce((a, b) => a + b.score_improvement, 0) / (upgraded || 1);
    // ETA: average seconds per completed doc
    const doneDocs = docs.filter(d => d.finished_at && d.started_at);
    const avgSec = doneDocs.length ? doneDocs.reduce((a, d) => a + (new Date(d.finished_at) - new Date(d.started_at)) / 1000, 0) / doneDocs.length : 300;
    const etaSeconds = pending * avgSec;
    return { domain, docs, totalDocs, scored, upgraded, pending, processing, failed, avgImprovement, etaSeconds };
  } finally { db.close(); }
};
/** Format seconds into human-readable duration. */
const fmtDuration = (sec) => {
  if (sec < 3600) return `~${Math.ceil(sec / 60)} min`;
  if (sec < 86400) return `~${Math.ceil(sec / 3600)} hr`;
  if (sec < 604800) return `~${Math.ceil(sec / 86400)} days`;
  return `~${Math.ceil(sec / 604800)} weeks`;
};
/** Score to Tailwind color class. */
const scoreColor = (score) => {
  if (score === null || score === undefined) return 'bg-gray-200 text-gray-500';
  if (score >= 0.8) return 'bg-green-100 text-green-800';
  if (score >= 0.6) return 'bg-yellow-100 text-yellow-800';
  if (score >= 0.4) return 'bg-orange-100 text-orange-800';
  return 'bg-red-100 text-red-800';
};
/** Build the full HTML page. */
const buildHtml = (sites, builtAt) => {
  const sitesJson = JSON.stringify(sites.filter(Boolean));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>site2rag PDF Upgrade Monitor</title>
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
<style>
  [x-cloak] { display: none !important; }
  .score-pill { @apply inline-block px-2 py-0.5 rounded text-xs font-mono font-semibold; }
  .truncate-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen" x-data="app()" x-cloak>

<div class="max-w-7xl mx-auto px-4 py-6">

  <!-- Header -->
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">PDF Upgrade Monitor</h1>
      <p class="text-sm text-gray-500 mt-1">site2rag archival OCR enhancement pipeline</p>
    </div>
    <div class="text-right text-xs text-gray-400">
      <div>Built: ${builtAt}</div>
      <div class="mt-1">Auto-rebuilds daily + after each upgrade</div>
    </div>
  </div>

  <!-- Site tabs -->
  <div class="border-b border-gray-200 mb-6">
    <nav class="-mb-px flex space-x-6" aria-label="Tabs">
      <template x-for="(site, i) in sites" :key="site.domain">
        <button
          @click="activeTab = i"
          :class="activeTab === i ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'"
          class="whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm transition-colors"
          x-text="site.domain"
        ></button>
      </template>
    </nav>
  </div>

  <!-- Per-site content -->
  <template x-for="(site, i) in sites" :key="site.domain">
    <div x-show="activeTab === i">

      <!-- Stats cards -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <div class="bg-white rounded-lg p-3 shadow-sm border border-gray-100 text-center">
          <div class="text-2xl font-bold text-gray-900" x-text="site.totalDocs"></div>
          <div class="text-xs text-gray-500 mt-1">Total PDFs</div>
        </div>
        <div class="bg-white rounded-lg p-3 shadow-sm border border-gray-100 text-center">
          <div class="text-2xl font-bold text-blue-600" x-text="site.scored"></div>
          <div class="text-xs text-gray-500 mt-1">Scored</div>
        </div>
        <div class="bg-white rounded-lg p-3 shadow-sm border border-gray-100 text-center">
          <div class="text-2xl font-bold text-green-600" x-text="site.upgraded"></div>
          <div class="text-xs text-gray-500 mt-1">Upgraded</div>
        </div>
        <div class="bg-white rounded-lg p-3 shadow-sm border border-gray-100 text-center">
          <div class="text-2xl font-bold text-yellow-600" x-text="site.pending"></div>
          <div class="text-xs text-gray-500 mt-1">Queued</div>
        </div>
        <div class="bg-white rounded-lg p-3 shadow-sm border border-gray-100 text-center">
          <div class="text-2xl font-bold text-red-500" x-text="site.failed"></div>
          <div class="text-xs text-gray-500 mt-1">Failed</div>
        </div>
        <div class="bg-white rounded-lg p-3 shadow-sm border border-gray-100 text-center">
          <div class="text-2xl font-bold text-gray-700" x-text="site.eta"></div>
          <div class="text-xs text-gray-500 mt-1">ETA remaining</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div class="bg-white rounded-lg p-4 shadow-sm border border-gray-100 mb-6">
        <div class="flex justify-between text-xs text-gray-500 mb-2">
          <span x-text="site.upgraded + ' of ' + site.totalDocs + ' documents upgraded'"></span>
          <span x-text="Math.round(site.upgraded / (site.totalDocs || 1) * 100) + '%'"></span>
        </div>
        <div class="w-full bg-gray-200 rounded-full h-3">
          <div class="bg-green-500 h-3 rounded-full transition-all"
               :style="'width:' + Math.round(site.upgraded / (site.totalDocs || 1) * 100) + '%'"></div>
        </div>
        <div class="flex gap-4 mt-3 text-xs text-gray-400">
          <span><span class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1"></span>Upgraded</span>
          <span><span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1"></span>Queued</span>
          <span><span class="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1"></span>Processing</span>
          <span><span class="inline-block w-2 h-2 rounded-full bg-gray-300 mr-1"></span>Not yet scored</span>
        </div>
      </div>

      <!-- Filters -->
      <div class="bg-white rounded-lg p-4 shadow-sm border border-gray-100 mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label class="block text-xs text-gray-500 mb-1">Search</label>
          <input type="text" x-model="filters[i].search" placeholder="title or URL..."
                 class="border border-gray-300 rounded px-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-300">
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Status</label>
          <select x-model="filters[i].status" class="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
            <option value="">All</option>
            <option value="done">Done</option>
            <option value="pending">Queued</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
            <option value="unscored">Not scored</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Max score</label>
          <input type="range" x-model="filters[i].maxScore" min="0" max="1" step="0.05"
                 class="w-24 accent-blue-500">
          <span class="text-xs text-gray-500 ml-1" x-text="'≤ ' + Number(filters[i].maxScore).toFixed(2)"></span>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">Sort</label>
          <select x-model="filters[i].sort" class="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
            <option value="score_asc">Score (worst first)</option>
            <option value="score_desc">Score (best first)</option>
            <option value="pages_desc">Pages (most first)</option>
            <option value="title_asc">Title A-Z</option>
            <option value="improved_desc">Most improved</option>
          </select>
        </div>
        <div class="ml-auto text-xs text-gray-400" x-text="filteredDocs(site, i).length + ' documents'"></div>
      </div>

      <!-- Document table -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-100 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="text-left px-4 py-3 font-medium text-gray-600 w-8">#</th>
              <th class="text-left px-4 py-3 font-medium text-gray-600">Document</th>
              <th class="text-center px-3 py-3 font-medium text-gray-600 w-16">Pages</th>
              <th class="text-center px-3 py-3 font-medium text-gray-600 w-24">Score</th>
              <th class="text-center px-3 py-3 font-medium text-gray-600 w-24">After</th>
              <th class="text-center px-3 py-3 font-medium text-gray-600 w-24">Status</th>
              <th class="text-left px-3 py-3 font-medium text-gray-600">Links</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <template x-for="(doc, di) in filteredDocs(site, i)" :key="doc.url">
              <tr class="hover:bg-gray-50 transition-colors">
                <td class="px-4 py-3 text-gray-400 text-xs" x-text="di + 1"></td>
                <td class="px-4 py-3">
                  <div class="font-medium text-gray-800 truncate-cell"
                       x-text="doc.title || doc.url.split('/').pop().replace(/\\.pdf$/i,'').replace(/[_-]/g,' ')"
                       :title="doc.url"></div>
                  <!-- Bad OCR sample (expandable) -->
                  <template x-if="doc.bad_sample && doc.composite_score !== null && doc.composite_score < 0.5">
                    <div class="mt-1">
                      <button @click="doc._expanded = !doc._expanded"
                              class="text-xs text-orange-500 hover:text-orange-700">
                        <span x-text="doc._expanded ? '▲ hide sample' : '▼ show OCR sample'"></span>
                      </button>
                      <div x-show="doc._expanded" x-cloak
                           class="mt-1 p-2 bg-orange-50 border border-orange-200 rounded text-xs font-mono text-gray-600 whitespace-pre-wrap break-all max-h-32 overflow-y-auto"
                           x-text="doc.bad_sample"></div>
                    </div>
                  </template>
                </td>
                <td class="px-3 py-3 text-center text-gray-500" x-text="doc.pages || '—'"></td>
                <td class="px-3 py-3 text-center">
                  <template x-if="doc.composite_score !== null">
                    <span class="score-pill"
                          :class="scoreColor(doc.composite_score)"
                          x-text="(doc.composite_score * 100).toFixed(0) + '%'"></span>
                  </template>
                  <template x-if="doc.composite_score === null">
                    <span class="text-gray-300 text-xs">—</span>
                  </template>
                </td>
                <td class="px-3 py-3 text-center">
                  <template x-if="doc.after_score !== null">
                    <span class="score-pill bg-green-100 text-green-800"
                          x-text="(doc.after_score * 100).toFixed(0) + '%'"></span>
                  </template>
                  <template x-if="doc.after_score === null">
                    <span class="text-gray-300 text-xs">—</span>
                  </template>
                </td>
                <td class="px-3 py-3 text-center">
                  <template x-if="doc.status === 'done'">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">✓ done</span>
                  </template>
                  <template x-if="doc.status === 'processing'">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 animate-pulse">⟳ running</span>
                  </template>
                  <template x-if="doc.status === 'pending'">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">◷ queued</span>
                  </template>
                  <template x-if="doc.status === 'failed'">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800" :title="doc.error">✗ failed</span>
                  </template>
                  <template x-if="!doc.status && doc.composite_score !== null">
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">scored</span>
                  </template>
                  <template x-if="!doc.status && doc.composite_score === null">
                    <span class="text-gray-300 text-xs">—</span>
                  </template>
                </td>
                <!-- Links: archive download + original source -->
                <td class="px-3 py-3">
                  <div class="flex flex-col gap-1 min-w-0">
                    <!-- Archive download (only when done) -->
                    <template x-if="doc.archive_url">
                      <a :href="doc.archive_url" target="_blank"
                         class="inline-flex items-center gap-1 text-xs font-semibold text-green-700 hover:text-green-900 hover:underline"
                         title="Download upgraded PDF from archive">
                        ↓ Download upgraded PDF
                      </a>
                    </template>
                    <!-- Original source URL — what to replace -->
                    <a :href="doc.url" target="_blank"
                       class="text-xs text-gray-400 hover:text-blue-600 hover:underline truncate-cell"
                       :title="'Original source: ' + doc.url">
                      <span class="text-gray-300 mr-1">⇒ replace:</span><span x-text="doc.url.replace(/^https?:\/\//, '')"></span>
                    </a>
                  </div>
                </td>
              </tr>
            </template>
            <template x-if="filteredDocs(site, i).length === 0">
              <tr><td colspan="7" class="text-center py-12 text-gray-400">No documents match filters</td></tr>
            </template>
          </tbody>
        </table>
      </div>

    </div>
  </template>

  <!-- Empty state -->
  <template x-if="sites.length === 0">
    <div class="text-center py-20 text-gray-400">
      <div class="text-4xl mb-4">📄</div>
      <div class="text-lg font-medium">No sites indexed yet</div>
      <div class="text-sm mt-2">Add sites to websites.yaml and start site2rag to begin</div>
    </div>
  </template>

  <div class="mt-8 text-center text-xs text-gray-400">
    site2rag pdf-upgrade monitor &mdash; private administrative view
  </div>
</div>

<script>
const SITES_DATA = ${sitesJson};
function scoreColor(score) {
  if (score === null || score === undefined) return 'bg-gray-200 text-gray-500';
  if (score >= 0.8) return 'bg-green-100 text-green-800';
  if (score >= 0.6) return 'bg-yellow-100 text-yellow-800';
  if (score >= 0.4) return 'bg-orange-100 text-orange-800';
  return 'bg-red-100 text-red-800';
}
function app() {
  return {
    sites: SITES_DATA.map(s => ({
      ...s,
      eta: s.etaSeconds > 0 ? (s.etaSeconds < 60 ? '<1 min' : s.etaSeconds < 3600 ? '~' + Math.ceil(s.etaSeconds/60) + ' min' : s.etaSeconds < 86400 ? '~' + Math.ceil(s.etaSeconds/3600) + ' hr' : s.etaSeconds < 604800 ? '~' + Math.ceil(s.etaSeconds/86400) + ' days' : '~' + Math.ceil(s.etaSeconds/604800) + ' wks') : '—'
    })),
    activeTab: 0,
    filters: SITES_DATA.map(() => ({ search: '', status: '', maxScore: 1, sort: 'score_asc' })),
    scoreColor,
    filteredDocs(site, i) {
      const f = this.filters[i];
      let docs = site.docs.filter(d => {
        if (f.search && !d.url.toLowerCase().includes(f.search.toLowerCase()) && !(d.title || '').toLowerCase().includes(f.search.toLowerCase())) return false;
        if (f.status === 'unscored' && d.composite_score !== null) return false;
        if (f.status && f.status !== 'unscored' && d.status !== f.status) return false;
        if (d.composite_score !== null && d.composite_score > Number(f.maxScore)) return false;
        return true;
      });
      const sorts = {
        score_asc: (a,b) => (a.composite_score ?? 1) - (b.composite_score ?? 1),
        score_desc: (a,b) => (b.composite_score ?? 0) - (a.composite_score ?? 0),
        pages_desc: (a,b) => (b.pages || 0) - (a.pages || 0),
        title_asc: (a,b) => (a.title || a.url).localeCompare(b.title || b.url),
        improved_desc: (a,b) => (b.score_improvement || 0) - (a.score_improvement || 0),
      };
      return docs.sort(sorts[f.sort] || sorts.score_asc);
    }
  };
}
</script>
</body>
</html>`;
};
/**
 * Build and write the report HTML from all site DBs.
 * @param {string[]} domains - List of site domain names to include
 */
export const buildReport = (domains) => {
  const reportPath = process.env.UPGRADE_REPORT_PATH || join(getSiteRoot(), 'report');
  mkdirSync(reportPath, { recursive: true });
  const sites = domains.map(gatherSiteData).filter(Boolean);
  const builtAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const html = buildHtml(sites, builtAt);
  writeFileSync(join(reportPath, 'index.html'), html, 'utf8');
  console.log(`[report] built ${join(reportPath, 'index.html')} (${sites.length} sites, ${sites.reduce((a,s) => a + s.totalDocs, 0)} docs)`);
};
// Run directly: node src/pdf-upgrade/report.js domain1 domain2
if (process.argv[2]) buildReport(process.argv.slice(2));
