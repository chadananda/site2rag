// Quick pipeline comparison test — runs new pipeline against previously-upgraded PDFs.
import { runPipeline } from '../src/pipeline/index.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(__dirname, 'test-pdfs');

const DOCS = [
  { file: 'memorandum-25-august-1989-on-john-the-baptist.pdf', meta: { language: 'en' }, oldScore: 0.84, label: 'English 2p (adib)' },
  { file: 'amanat_kashan_55-56.pdf',                           meta: { language: 'fa' }, oldScore: 0.74, label: 'Persian 2p (adib)' },
  { file: 'vasaya_02.pdf',                                     meta: { language: 'en' }, oldScore: 0.74, label: 'English 5p (BL)' },
  { file: 'seven-valleys-zh.pdf',                              meta: { language: 'zh' }, oldScore: 0.65, label: 'Chinese 13p (BL)' },
];

const fmt = (n) => n == null ? 'n/a  ' : (n * 100).toFixed(1) + '%';
const fmtCost = (n) => n > 0 ? '$' + n.toFixed(4) : '$0.0000';

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  failFast: false,
  skip: ['s7'],  // skip OCRmyPDF rebuild for speed
};

console.log('\n=== Pipeline Comparison Test ===\n');
console.log('Doc'.padEnd(28) + 'Pg  Base   New    Old    Δ       Words  Vis  Cost');
console.log('─'.repeat(85));

for (const doc of DOCS) {
  const pdfPath = join(PDF_DIR, doc.file);
  const docId = doc.file.replace(/\.pdf$/, '');
  process.stdout.write(doc.label.padEnd(28));

  try {
    const ctx = await runPipeline({ docId, sourcePath: pdfPath, sourceUrl: 'https://test/' + doc.file,
      importance: 2, meta: doc.meta, config });
    const r = ctx.toReceipt();
    const base  = r.quality.baseline?.composite_score;
    const final = r.quality.final;
    const delta = final != null && doc.oldScore != null ? final - doc.oldScore : null;
    const words = ctx.pages.reduce((s, p) => s + (p.words?.length ?? 0), 0);
    const vis   = ctx.pages.filter(p => p.visionMd).length;
    const warns = ctx.metrics.errors.filter(e => e.recoverable).length;

    console.log(
      String(ctx.pageCount).padEnd(4) +
      fmt(base).padEnd(7) +
      fmt(final).padEnd(7) +
      fmt(doc.oldScore).padEnd(7) +
      (delta != null ? ((delta>=0?'+':'') + (delta*100).toFixed(1)+'%').padEnd(8) : 'n/a     ') +
      String(words).padEnd(7) +
      String(vis+'v').padEnd(5) +
      fmtCost(r.totals.cost_usd) +
      (warns ? `  ⚠${warns}` : '')
    );

    // Stage notes
    for (const s of r.stages) {
      if (s.notes && s.notes !== 'null' && !s.notes.startsWith('skip')) {
        console.log(`  ${s.stage}: ${s.notes}`);
      }
    }
    // Suggestions
    for (const sg of (r.suggestions || [])) {
      if (sg.priority !== 'low') console.log(`  💡 [${sg.priority}] ${sg.category}: ${sg.suggestion}`);
    }
    // Peek at first line of exported MD
    if (ctx.outputs.mdPath && existsSync(ctx.outputs.mdPath)) {
      const md = readFileSync(ctx.outputs.mdPath, 'utf8');
      const line = md.split('\n').find(l => l.trim() && !l.startsWith('<!--'));
      if (line) console.log(`  📄 "${line.slice(0,90)}"`);
    }

  } catch (err) {
    console.log('ERROR: ' + err.message);
  }
}

console.log('─'.repeat(85));
console.log('Base=s0 score, New=after full pipeline, Old=previous OCRmyPDF, Δ=new-old\n');

// Re-score the markdown outputs to measure actual quality
import { scorePdf as _score } from '../src/pdf-upgrade/score.js';
import { existsSync as _exists, statSync as _stat } from 'fs';

console.log('\n=== Word Confidence Analysis ===\n');
// Re-run to get ctx data
for (const doc of DOCS) {
  const pdfPath = join(PDF_DIR, doc.file);
  const ctx = await runPipeline({ 
    docId: doc.file.replace(/\.pdf$/, '') + '_rescore',
    sourcePath: pdfPath,
    sourceUrl: 'https://test/' + doc.file,
    importance: 2, meta: doc.meta,
    config: { ...config, skip: ['s0','s1','s2','s4','s5','s6','s7','s8'] } 
  });
  const all = ctx.pages.flatMap(p => p.words ?? []);
  const clean = all.filter(w => w.conf >= 90).length;
  const fuzzy = all.filter(w => w.conf >= 60 && w.conf < 90).length;
  const dirty = all.filter(w => w.conf < 60).length;
  const pct = all.length > 0 ? Math.round(clean/all.length*100) : 0;
  console.log(`${doc.label}: ${all.length} words, clean=${clean}(${pct}%) fuzzy=${fuzzy} dirty=${dirty}`);
}
