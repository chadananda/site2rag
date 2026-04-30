// PDF/A-3 rebuild -- overlays OCR text onto original PDF pages using OCRmyPDF.
// Preserves original scan quality; adds searchable invisible text layer + XMP metadata.
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Rebuild a PDF with a high-quality OCR text layer via OCRmyPDF.
 * @param {string} inputPdfPath - Original PDF
 * @param {string} outputPdfPath - Where to write upgraded PDF/A-3
 * @param {Array<{pageNo,text_md}>} ocrResults - Per-page OCR text
 * @returns {object} { success, method, error }
 */
export const rebuildPdf = async (inputPdfPath, outputPdfPath, ocrResults) => {
  mkdirSync(dirname(outputPdfPath), { recursive: true });

  // Write a sidecar text file (one page per \f separator) for OCRmyPDF --sidecar-input
  // OCRmyPDF doesn't support sidecar input directly, so we use --force-ocr with tesseract skip
  // and inject text via pdf-lib invisible text as a fallback approach.
  // Primary approach: OCRmyPDF with --redo-ocr for cleaner PDF/A output.
  try {
    const args = [
      inputPdfPath,
      outputPdfPath,
      '--output-type', 'pdfa-3',
      '--pdfa-image-compression', 'lossless',
      '--optimize', '1',
      '--skip-text',       // don't re-OCR pages that already have text
      '--rotate-pages',
      '--deskew',
      '--clean',
      '--jobs', '2',
      '--quiet'
    ];
    await execFileAsync('ocrmypdf', args, { timeout: 300_000 });
    return { success: true, method: 'ocrmypdf-pdfa3' };
  } catch (err) {
    // Fallback: copy original and embed text with pdf-lib
    try {
      const result = await injectTextLayer(inputPdfPath, outputPdfPath, ocrResults);
      return { success: true, method: 'pdf-lib-overlay', ...result };
    } catch (err2) {
      return { success: false, method: null, error: `ocrmypdf: ${err.message}; pdf-lib: ${err2.message}` };
    }
  }
};

/** Inject invisible text overlay per page using pdf-lib. */
const injectTextLayer = async (inputPdfPath, outputPdfPath, ocrResults) => {
  const { PDFDocument, rgb, StandardFonts } = await import('pdf-lib');
  const pdfBytes = readFileSync(inputPdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const { pageNo, text_md } of ocrResults) {
    const page = pages[pageNo - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const lines = text_md.split('\n').filter(l => l.trim());
    const lineHeight = height / Math.max(lines.length, 1);
    lines.forEach((line, idx) => {
      const clean = line.replace(/[^\x20-\x7E]/g, ' ').trim();
      if (!clean) return;
      try {
        page.drawText(clean, {
          x: 0, y: height - lineHeight * (idx + 1),
          size: Math.max(lineHeight * 0.8, 1),
          font, color: rgb(1, 1, 1), // invisible white
          opacity: 0
        });
      } catch { /* skip invalid chars */ }
    });
  }

  // XMP metadata
  const now = new Date().toISOString();
  pdfDoc.setTitle(pdfDoc.getTitle() || '');
  pdfDoc.setModificationDate(new Date());
  pdfDoc.setKeywords(['OCR-upgraded', 'site2rag', now.slice(0, 10)]);

  const outBytes = await pdfDoc.save({ addDefaultPage: false });
  writeFileSync(outputPdfPath, outBytes);
  return {};
};
