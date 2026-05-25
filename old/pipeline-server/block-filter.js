// Block legitimacy filter. Runs before OCR to skip garbage regions.
// Exports: classifyBlock, filterBlocks, BLOCK_TYPES
// Deps: none (pure geometry + pixel stats, no OCR needed)
//
// Archival scans have binding shadows, fold artifacts, page-edge debris, stamps,
// library markings — not every detected region deserves OCR cycles.
// This filter uses cheap heuristics on the raster image to classify and skip garbage.

export const BLOCK_TYPES = {
  TEXT:          'text',           // → route to OCR engines
  TABLE:         'table',          // → route to layout-aware engines (docTR, PaddleOCR)
  FIGURE:        'figure',         // → skip OCR (or caption detection only)
  EQUATION:      'equation',       // → route to Mathpix if available, else Claude Vision
  MARGINALIA:    'marginalia',     // → OCR but low priority, lower quality threshold
  EDGE_ARTIFACT: 'edge_artifact',  // → skip (binding shadow, fold, scan border)
  STAMP:         'stamp',          // → skip or flag for separate handling
  NOISE:         'noise',          // → skip (too small, too sparse, or pure noise)
  HANDWRITTEN:   'handwritten',    // → route to handwriting-capable engines
};

/**
 * Classify a single region using geometry heuristics.
 * region: { x1, y1, x2, y2, type? }
 * pngPath: path to page PNG (pixel density check is a TODO — see below)
 * Returns one of BLOCK_TYPES values.
 */
export function classifyBlock(region, pageWidth, pageHeight, pngPath) {
  const { x1, y1, x2, y2 } = region;
  const rw = x2 - x1;
  const rh = y2 - y1;
  const pageArea = pageWidth * pageHeight;
  const regionArea = rw * rh;
  // --- Edge artifact detection (check first) ---
  const edgeMarginX = pageWidth * 0.03;
  const edgeMarginY = pageHeight * 0.03;
  const touchesEdge = x1 <= edgeMarginX || y1 <= edgeMarginY || x2 >= pageWidth - edgeMarginX || y2 >= pageHeight - edgeMarginY;
  if (touchesEdge && regionArea < pageArea * 0.15) return BLOCK_TYPES.EDGE_ARTIFACT;
  const aspectRatio = rw > 0 && rh > 0 ? Math.max(rw / rh, rh / rw) : 999;
  if (aspectRatio > 20) return BLOCK_TYPES.EDGE_ARTIFACT;
  // --- Size-based noise ---
  if (rw < pageWidth * 0.02 || rh < pageHeight * 0.01) return BLOCK_TYPES.NOISE;
  if (regionArea < pageArea * 0.001) return BLOCK_TYPES.NOISE;
  // --- Position-based marginalia ---
  const touchesLeft = x1 <= edgeMarginX;
  const touchesRight = x2 >= pageWidth - edgeMarginX;
  if (rw < pageWidth * 0.15 && (touchesLeft || touchesRight)) return BLOCK_TYPES.MARGINALIA;
  const inTopStrip = y2 <= pageHeight * 0.10;
  const inBottomStrip = y1 >= pageHeight * 0.90;
  if (rh < pageHeight * 0.05 && (inTopStrip || inBottomStrip)) return BLOCK_TYPES.MARGINALIA;
  // TODO: pixel density analysis — load region from pngPath (sharp/canvas), compute
  //   dark pixel ratio. density < 0.02 → NOISE, density > 0.85 → EDGE_ARTIFACT.
  //   Skipped for now: per-region raster load adds complexity and the geometry
  //   heuristics above already eliminate most garbage in practice.
  // --- Trust layout engine type hint unless edge/noise overrides (already handled above) ---
  if (region.type) {
    const t = region.type.toLowerCase();
    if (t === 'table') return BLOCK_TYPES.TABLE;
    if (t === 'figure' || t === 'image') return BLOCK_TYPES.FIGURE;
    if (t === 'equation' || t === 'formula' || t === 'math') return BLOCK_TYPES.EQUATION;
    if (t === 'handwritten' || t === 'handwriting') return BLOCK_TYPES.HANDWRITTEN;
    if (t === 'stamp') return BLOCK_TYPES.STAMP;
    if (t === 'marginalia') return BLOCK_TYPES.MARGINALIA;
    if (t === 'noise') return BLOCK_TYPES.NOISE;
    if (t === 'text') return BLOCK_TYPES.TEXT;
  }
  return BLOCK_TYPES.TEXT;
}

/**
 * Classify all regions and group them by routing target.
 * Returns { toOcr, toTable, toFigure, toEquation, toMarginalia, skipped }
 */
export function filterBlocks(regions, pageWidth, pageHeight, pngPath) {
  const toOcr = [], toTable = [], toFigure = [], toEquation = [], toMarginalia = [], skipped = [];
  const skippedTypes = {};
  for (const region of regions) {
    const classification = classifyBlock(region, pageWidth, pageHeight, pngPath);
    const annotated = { ...region, _blockType: classification };
    if (classification === BLOCK_TYPES.TEXT || classification === BLOCK_TYPES.HANDWRITTEN) toOcr.push(annotated);
    else if (classification === BLOCK_TYPES.TABLE) toTable.push(annotated);
    else if (classification === BLOCK_TYPES.FIGURE) toFigure.push(annotated);
    else if (classification === BLOCK_TYPES.EQUATION) toEquation.push(annotated);
    else if (classification === BLOCK_TYPES.MARGINALIA) toMarginalia.push(annotated);
    else { skipped.push(annotated); skippedTypes[classification] = (skippedTypes[classification] ?? 0) + 1; }
  }
  const skippedSummary = Object.entries(skippedTypes).map(([t, n]) => `${n} ${t}`).join(', ');
  const total = regions.length;
  const pageLabel = regions[0]?._pageNo != null ? `page ${regions[0]._pageNo}` : 'page';
  console.log(`${pageLabel}: ${total} regions → ${toOcr.length} text, ${toTable.length} table, ${toEquation.length} eq, ${toFigure.length} fig, ${toMarginalia.length} marginalia${skipped.length ? `, ${skipped.length} skipped (${skippedSummary})` : ''}`);
  return { toOcr, toTable, toFigure, toEquation, toMarginalia, skipped };
}
