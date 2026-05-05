// Shared test helpers for pipeline tests.
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineContext } from '../../src/pipeline/context.js';
import { DEFAULT_CONFIG } from '../../src/pipeline/config.js';

/** Create a temp dir, return path and cleanup fn. */
export const makeTempDir = () => {
  const dir = join(tmpdir(), `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Minimal valid 1-page text PDF (embeds ASCII text in content stream). */
export const makeTextPdf = (text = 'Hello world this is a test document page one') => {
  const safeText = text.replace(/[()\\]/g, '\\$&');
  const stream = `BT /F1 12 Tf 50 750 Td (${safeText}) Tj ET`;
  const objs = [
    null,
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = body.length;
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) body += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  body += `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
};

/** Build a PipelineContext with sensible test defaults. */
export const makeCtx = (overrides = {}) => {
  const { dir = tmpdir(), pdfPath = null, importance = 2, config = {} } = overrides;
  const sourcePath = pdfPath ?? join(dir, 'test.pdf');
  return new PipelineContext({
    docId: `test-${Date.now()}`,
    sourcePath,
    sourceUrl: 'https://example.com/test.pdf',
    importance,
    config: { ...DEFAULT_CONFIG, failFast: false, ...config },
    meta: { title: 'Test Document' },
  });
};

/** Populate ctx.pages with synthetic word data for testing stages 4-8. */
export const makePageWords = (pageNo, words) => ({
  pageNo,
  words: words.map(({ text, conf = 95, x1 = 10, y1 = 10, x2 = 50, y2 = 20 }) =>
    ({ text, conf, x1, y1, x2, y2, source: 'tesseract', pageNo })),
  regions: [],
  quality: {},
});

/** Assert that a stage record exists and has the expected shape. */
export const assertStageRecord = (ctx, stageName, expect) => {
  const record = ctx.metrics.stages.find(s => s.stage === stageName);
  expect(record).toBeDefined();
  expect(record).toMatchObject({ stage: stageName, duration_ms: expect.any(Number) });
  return record;
};

/** Assert that ctx.metrics.errors has no non-recoverable errors. */
export const assertNoFatalErrors = (ctx, expect) => {
  const fatal = ctx.metrics.errors.filter(e => !e.recoverable);
  expect(fatal).toHaveLength(0);
};
