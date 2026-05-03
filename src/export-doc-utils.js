// PDF export utilities: backlink annotation and page assembly. Exports: addBacklink, assembleDocMd
/** Append backlink annotation to paragraph text. granularity='page' skips (page headers added separately). */
export const addBacklink = (text, sourceUrl, pageNo, paraNo, format, granularity) => {
  if (granularity === 'page') return text;
  const anchor = `${sourceUrl}#page=${pageNo}`;
  const visibleLink = ` [↗ p.${pageNo}](${anchor})`;
  const dataSpan = `\n<span data-pdf-page="${pageNo}" data-pdf-para="${paraNo}" data-pdf-src="${anchor}"></span>`;
  if (format === 'visible') return text + visibleLink;
  if (format === 'comment') return text + dataSpan;
  return text + visibleLink + dataSpan;
};

const pageHeader = (sourceUrl, pageNo) => `## Page ${pageNo} [↗](${sourceUrl}#page=${pageNo})\n\n`;

/** Assemble full MD from per-page results, adding backlinks or page headers per config. */
export const assembleDocMd = (pageResults, sourceUrl, backlinkFormat, backlinkGranularity) => {
  return pageResults.map(({ pageNo, text_md }) => {
    const paragraphs = text_md.split(/\n{2,}/);
    if (backlinkGranularity === 'page') {
      return pageHeader(sourceUrl, pageNo) + paragraphs.join('\n\n');
    }
    return paragraphs
      .map((p, idx) => p.trim() ? addBacklink(p, sourceUrl, pageNo, idx + 1, backlinkFormat, backlinkGranularity) : p)
      .join('\n\n');
  }).join('\n\n');
};
