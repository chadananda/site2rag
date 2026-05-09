// Test corpus: 10 representative short documents (1-8 pages) of varying type/language/quality.
// Exports: CORPUS (array of {id, url, localPath, category, language, hasTextLayer, baselineScore})
// Deps: src/db.js, src/mirror-crawl.js

import { openDb } from '../../src/db.js';
import { urlToMirrorPath } from '../../src/mirror-crawl.js';
import { existsSync } from 'fs';

const DOMAIN = 'bahai-library.com';

export async function buildCorpus(opts = {}) {
  const { maxPages = 8, domain = DOMAIN } = opts;
  const db = openDb(domain);

  const rows = db.prepare(`
    SELECT pq.url, pq.pages, pq.ai_language, pq.has_text_layer,
           pq.composite_score, pq.readable_pages_pct, pq.word_quality_estimate
    FROM pdf_quality pq
    WHERE pq.pages BETWEEN 1 AND ? AND pq.url LIKE '%.pdf'
    ORDER BY pq.ai_language, pq.has_text_layer, pq.composite_score
  `).all(maxPages);

  const cats = {
    english_text_good:  rows.filter(d => d.ai_language==='english' && d.has_text_layer===1 && (d.composite_score??0) > 0.7),
    english_scan_ok:    rows.filter(d => d.ai_language==='english' && d.has_text_layer===0 && (d.composite_score??0) > 0.3),
    english_scan_poor:  rows.filter(d => d.ai_language==='english' && d.has_text_layer===0 && (d.composite_score??0) <= 0.3),
    french_scan:        rows.filter(d => d.ai_language==='french'  && d.has_text_layer===0),
    arabic_scan:        rows.filter(d => d.ai_language==='arabic'  && d.has_text_layer===0),
    persian_scan:       rows.filter(d => d.ai_language==='persian' && d.has_text_layer===0),
  };

  const corpus = [];
  for (const [cat, list] of Object.entries(cats)) {
    for (const doc of list.slice(0, 2)) {
      const localPath = urlToMirrorPath(domain, doc.url);
      if (!existsSync(localPath)) continue;
      corpus.push({
        id: cat + '_' + doc.url.split('/').pop().replace(/[^a-z0-9]/gi,'_').slice(0,30),
        category: cat,
        url: doc.url,
        localPath,
        language: doc.ai_language,
        hasTextLayer: doc.has_text_layer === 1,
        pages: doc.pages,
        baselineScore: doc.composite_score ?? 0,
      });
      if (corpus.filter(c => c.category === cat).length >= 2) break;
    }
  }

  return corpus;
}
