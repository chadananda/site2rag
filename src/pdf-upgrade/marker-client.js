// Marker PDF-to-Markdown HTTP client. Exports: markerAvailable, convertPdfWithMarker, scoreMarkdown. Deps: marker-service on MARKER_URL
const MARKER_URL = process.env.MARKER_URL || 'http://localhost:7842';

/** Returns true if Marker service is reachable. */
export const markerAvailable = async () => {
  try {
    const res = await fetch(`${MARKER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
};

/**
 * Convert a PDF to Markdown via the Marker service.
 * @param {string} pdfPath - absolute local path to the PDF
 * @returns {Promise<string>} Markdown text
 */
export const convertPdfWithMarker = async (pdfPath) => {
  const res = await fetch(`${MARKER_URL}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_path: pdfPath }),
    signal: AbortSignal.timeout(180_000) // 3 min max
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`marker HTTP ${res.status}: ${err}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'marker conversion failed');
  return data.markdown;
};

/**
 * Score Markdown quality 0–1. Used to decide if Marker output is good enough
 * to mark a document done (skip boss OCR pass).
 * Threshold ~0.55 in practice.
 */
export const scoreMarkdown = (md) => {
  if (!md || md.length < 100) return 0;
  const words = md.split(/\s+/).filter(w => w.length > 2).length;
  if (words < 30) return 0.1;
  const uniqueWords = new Set(md.toLowerCase().split(/\W+/).filter(Boolean)).size;
  const density = Math.min(md.length / 3000, 1);
  const diversity = Math.min(uniqueWords / Math.max(words, 1) * 2, 1);
  return Math.round((density * 0.5 + diversity * 0.5) * 100) / 100;
};
