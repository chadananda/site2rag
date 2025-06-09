// src/preprocessing.js
// Full-featured HTML preprocessing pipeline for site2rag, based on html-preprocessing.md
import { load } from 'cheerio';

// --- Metadata Extraction ---
export class MetadataExtractor {
  extractPageContext(html, url) {
    const $ = load(html);
    return {
      url,
      title: this.extractTitle($),
      description: this.extractDescription($),
      breadcrumbs: this.extractBreadcrumbs($),
      siteSection: this.identifySection($),
      pageType: this.inferPageType($, url),
      relatedPages: this.extractRelatedLinks($),
      externalReferences: this.extractExternalLinks($),
      internalLinks: this.countInternalLinks($),
      lastModified: this.extractLastModified($),
      author: this.extractAuthor($),
      publishDate: this.extractPublishDate($),
      estimatedReadingTime: this.calculateReadingTime($),
      contentLanguage: this.detectLanguage($),
      hasCodeExamples: $('code, pre').length > 0,
      hasImages: $('img').length,
      hasTables: $('table').length,
      headingStructure: this.analyzeHeadingStructure($),
      metaKeywords: $('meta[name="keywords"]').attr('content'),
      canonicalUrl: $('link[rel="canonical"]').attr('href'),
    };
  }
  extractTitle($) { return $('title').text().trim() || $('h1').first().text().trim(); }
  extractDescription($) { return $('meta[name="description"]').attr('content') || ''; }
  extractBreadcrumbs($) {
    const selectors = ['.breadcrumb a, .breadcrumbs a', '[role="navigation"] a', '.nav-breadcrumb a', 'nav ol a, nav ul a'];
    for (const selector of selectors) {
      const breadcrumbs = $(selector).map((_, el) => ({ text: $(el).text().trim(), url: $(el).attr('href') })).get();
      if (breadcrumbs.length > 0) return breadcrumbs;
    }
    return [];
  }
  identifySection($) { return $('meta[property="article:section"]').attr('content') || ''; }
  inferPageType($, url) {
    if (/\/(api|reference)\//.test(url)) return 'api-reference';
    if (/\/(tutorial|guide|how-to)\//.test(url)) return 'tutorial';
    if (/\/(blog|news|article)\//.test(url)) return 'article';
    if (/\/(changelog|release)\//.test(url)) return 'changelog';
    if ($('code, pre').length > 5) return 'technical-reference';
    if ($('.tutorial, .how-to').length > 0) return 'tutorial';
    if ($('h1').text().toLowerCase().includes('getting started')) return 'getting-started';
    return 'documentation';
  }
  extractRelatedLinks($) {
    const selectors = ['.related-links a', '.see-also a', '.further-reading a', '.next-prev a', '.pagination a', '.series-nav a'];
    const related = [];
    selectors.forEach(selector => {
      $(selector).each((_, el) => {
        const $el = $(el);
        related.push({ text: $el.text().trim(), url: $el.attr('href') });
      });
    });
    return related;
  }
  extractExternalLinks($) {
    return $('a[href^="http"]').map((_, el) => $(el).attr('href')).get();
  }
  countInternalLinks($) {
    return $('a[href^="/"]').length;
  }
  extractLastModified($) { return $('meta[name="last-modified"]').attr('content') || ''; }
  extractAuthor($) { return $('meta[name="author"]').attr('content') || ''; }
  extractPublishDate($) { return $('meta[property="article:published_time"]').attr('content') || ''; }
  calculateReadingTime($) {
    const words = $('body').text().split(/\s+/).length;
    return Math.ceil(words / 200); // 200wpm
  }
  detectLanguage($) { return $('html').attr('lang') || ''; }
  analyzeHeadingStructure($) {
    const headings = [];
    $('h1,h2,h3,h4,h5,h6').each((_, el) => {
      const $el = $(el);
      headings.push({ level: parseInt(el.tagName.slice(1)), text: $el.text().trim(), id: $el.attr('id') || null });
    });
    return headings;
  }
}

// --- Navigation Removal ---
export class NavigationRemover {
  removeAllNavigation(html) {
    const $ = load(html);
    const navigationSelectors = [
      'nav', 'header:not(.article-header)', 'footer', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '.breadcrumb', '.breadcrumbs', '.nav-breadcrumb', '.site-nav', '.main-nav', '.top-nav', '.bottom-nav',
      'aside:not(.content-aside)', '.sidebar', '.side-nav', '.toc', '.table-of-contents', '.page-nav',
      '.related-links', '.see-also', '.further-reading', '.next-prev', '.pagination', '.series-nav',
      '.site-header', '.site-footer', '.page-header:not(.content-header)', '.skip-links', '.accessibility-nav',
      'script', 'style', 'noscript', '.sr-only', '.visually-hidden'
    ];
    navigationSelectors.forEach(selector => $(selector).remove());
    this.removeTemplateElements($);
    return $.html();
  }
  removeTemplateElements($) {
    $('*').each((_, el) => {
      const $el = $(el);
      const classes = ($el.attr('class') || '').toLowerCase();
      const id = ($el.attr('id') || '').toLowerCase();
      const text = $el.text().trim();
      if (this.isTemplateElement(classes, id)) { $el.remove(); return; }
      if (text.length < 100 && this.isTemplateText(text)) { $el.remove(); }
    });
  }
  isTemplateElement(classes, id) {
    const pattern = /banner|popup|modal|overlay|widget|component|advertisement|promo|social|share|cookie|gdpr|newsletter|signup/;
    return pattern.test(classes) || pattern.test(id);
  }
  isTemplateText(text) {
    const patterns = [
      /^(home|about|contact|login|signup|subscribe)$/i,
      /copyright|©|all rights reserved/i,
      /privacy policy|terms of service|cookie policy/i,
      /follow us|share this|like us/i
    ];
    return patterns.some(p => p.test(text));
  }
}

// --- Content Block Analysis ---
import { aiServiceAvailable, classifyBlocksWithAI } from './ai_assist.js';
import { SelectorDB } from './db_block_selectors.js';

export class ContentBlockAnalyzer {
  /**
   * @param {object} aiConfig - AI config ({provider, host, model, ...}) from site/global config. Defaults to Ollama local.
   * @param {string} selectorDbPath - Path to the crawl DB for selector learning. Defaults to 'site2rag.sqlite'.
   */
  constructor(aiConfig = {}, selectorDbPath = 'site2rag.sqlite') {
    this.aiConfig = {
      provider: 'ollama',
      host: 'http://localhost:11434',
      model: 'llama3.2:latest',
      ...aiConfig
    };
    this.selectorDbPath = selectorDbPath;
  }
  /**
   * Analyze and filter content blocks, using selector learning and AI for ambiguous block removal if available.
   * 1. Check SelectorDB for known selectors and apply actions automatically.
   * 2. Only send ambiguous/unseen selectors to AI.
   * 3. After AI, record all AI decisions in SelectorDB for future learning.
   */
  async analyzeContentBlocks(cleanHtml) {
    const $ = load(cleanHtml);
    const blocks = [];
    $('main, article, section, div, aside, blockquote, details').each((index, element) => {
      const $el = $(element);
      const block = this.createEnhancedBlockSummary($el, index);
      if (this.hasContentPotential(block)) blocks.push(block);
    });
    // --- Selector learning integration ---
    const selectorDB = new SelectorDB(this.selectorDbPath);
    const clearKeep = [];
    const clearRemove = [];
    const ambiguous = [];
    for (const block of blocks) {
      // Step 1: Use selector DB if available
      const selectorAction = selectorDB.getActionForSelector(block.selector);
      if (selectorAction === 'keep') {
        clearKeep.push(block);
        continue;
      }
      if (selectorAction === 'delete') {
        clearRemove.push(block);
        continue;
      }
      // Otherwise, use heuristics
      if (block.contentScore >= 15) {
        clearKeep.push(block);
      } else if (
        block.looksLikeNavigation ||
        block.looksLikeBoilerplate ||
        block.totalWordCount < 10 ||
        (block.linkDensity > 0.8 && block.totalWordCount < 50) ||
        block.contentScore <= 2
      ) {
        clearRemove.push(block);
      } else {
        ambiguous.push(block);
      }
    }
    let finalBlocks = [...clearKeep];
    // Step 2: AI for ambiguous blocks
    const aiAvailable = ambiguous.length > 0 && (await aiServiceAvailable(this.aiConfig));
    let aiRemoveIdxs = [];
    if (ambiguous.length > 0 && aiAvailable) {
      const blockHtmls = ambiguous.map(b => b.textSample || '');
      aiRemoveIdxs = await classifyBlocksWithAI(blockHtmls, this.aiConfig);
      finalBlocks = finalBlocks.concat(
        ambiguous.filter((_, i) => !aiRemoveIdxs.includes(i))
      );
    } else {
      finalBlocks = finalBlocks.concat(ambiguous);
    }
    // Step 3: Record selector actions in DB for all AI-classified ambiguous blocks
    ambiguous.forEach((block, i) => {
      if (aiRemoveIdxs.includes(i)) {
        selectorDB.recordSelector(block.selector, 'delete');
      } else {
        selectorDB.recordSelector(block.selector, 'keep');
      }
    });
    selectorDB.close();
    // Sort by original order
    finalBlocks.sort((a, b) => a.index - b.index);
    return finalBlocks;
  }
  createEnhancedBlockSummary($el, index) {
    const directText = $el.clone().children().remove().end().text().trim();
    const allText = $el.text().trim();
    return {
      index,
      selector: this.generateDetailedSelector($el),
      tag: $el[0].tagName.toLowerCase(),
      id: $el.attr('id') || '',
      classes: ($el.attr('class') || '').split(/\s+/).filter(c => c),
      directWordCount: this.countWords(directText),
      totalWordCount: this.countWords(allText),
      textSample: this.createTextSample(allText),
      paragraphCount: $el.find('p').length,
      headingCount: $el.find('h1,h2,h3,h4,h5,h6').length,
      listCount: $el.find('ul,ol').length,
      codeBlockCount: $el.find('pre,code').length,
      tableCount: $el.find('table').length,
      imageCount: $el.find('img').length,
      linkCount: $el.find('a').length,
      linkDensity: this.calculateLinkDensity($el),
      textDensity: this.calculateTextDensity($el),
      semanticScore: this.calculateSemanticScore($el),
      contentScore: 0, // Will be calculated
      depth: this.calculateDOMDepth($el),
      parentTag: $el.parent()[0]?.tagName?.toLowerCase() || '',
      siblingCount: $el.siblings().length,
      position: index,
      hasStructuredContent: this.hasStructuredContent($el),
      looksLikeNavigation: this.looksLikeNavigation($el),
      looksLikeBoilerplate: this.looksLikeBoilerplate($el, allText)
    };
  }
  generateDetailedSelector($el) {
    const tag = $el[0].tagName.toLowerCase();
    const id = $el.attr('id');
    const classes = ($el.attr('class') || '').split(/\s+/).filter(c => c);
    let selector = tag;
    if (id) selector += `#${id}`;
    if (classes.length > 0) selector += `.${classes.join('.')}`;
    return selector;
  }
  countWords(text) { return text ? text.split(/\s+/).length : 0; }
  createTextSample(text) { return text.length > 200 ? text.slice(0, 200) + '...' : text; }
  calculateLinkDensity($el) {
    const linkCount = $el.find('a').length;
    const textLength = $el.text().trim().length;
    return textLength ? linkCount / textLength : 0;
  }
  calculateTextDensity($el) {
    // Cheerio elements do not have .width() or .height(). Use text length only.
    const textLength = $el.text().trim().length;
    // For server-side, just use text length as density (area=1)
    return textLength;
  }
  calculateSemanticScore($el) {
    let score = 0;
    if ($el.is('main,article')) score += 15;
    if ($el.is('section') && $el.find('h1,h2,h3').length > 0) score += 10;
    score += Math.min($el.find('p').length * 2, 10);
    score += Math.min($el.find('h1,h2,h3,h4,h5,h6').length * 3, 9);
    score += Math.min($el.find('code,pre').length * 2, 6);
    score += Math.min($el.find('ul,ol').length, 4);
    const classes = ($el.attr('class') || '').toLowerCase();
    const id = ($el.attr('id') || '').toLowerCase();
    if (/nav|menu|header|footer|sidebar|widget/.test(classes + ' ' + id)) score -= 10;
    if (/ad|promo|banner|social/.test(classes + ' ' + id)) score -= 8;
    if (this.looksLikeNavigation($el)) score -= 12;
    return score;
  }
  calculateDOMDepth($el) {
    let depth = 0, node = $el;
    while (node.parent().length) { depth++; node = node.parent(); }
    return depth;
  }
  hasStructuredContent($el) {
    return $el.find('table, ul, ol, dl').length > 0;
  }
  looksLikeNavigation($el) {
    const linkCount = $el.find('a').length;
    const textLength = $el.text().trim().length;
    const linkDensity = linkCount > 0 ? (linkCount * 20) / textLength : 0;
    if (linkDensity > 0.5 && linkCount > 2) return true;
    const text = $el.text().toLowerCase();
    const navPatterns = /\b(home|about|contact|menu|navigation|sitemap|previous|next|back)\b/;
    return navPatterns.test(text) && textLength < 200;
  }
  looksLikeBoilerplate($el, text) {
    const patterns = [
      /copyright|©|all rights reserved/i,
      /privacy policy|terms of service/i,
      /\d{4}.*?(company|corp|inc|ltd)/i,
      /powered by|built with/i
    ];
    return patterns.some(p => p.test(text)) && text.length < 100;
  }
  hasContentPotential(block) {
    // Heuristic: block must have some content structure or length
    return block.totalWordCount > 10 || block.paragraphCount > 1 || block.headingCount > 0;
  }
  applyIntelligentFiltering(blocks) {
    return blocks.filter(block => {
      if (block.looksLikeNavigation) return false;
      if (block.looksLikeBoilerplate) return false;
      if (block.totalWordCount < 10) return false;
      if (block.linkDensity > 0.8 && block.totalWordCount < 50) return false;
      return true;
    }).map(block => ({ ...block, contentScore: this.calculateContentScore(block) }))
      .sort((a, b) => b.contentScore - a.contentScore);
  }
  calculateContentScore(block) {
    // Simple: semantic + length + structure
    let score = block.semanticScore + block.totalWordCount / 10;
    score += block.paragraphCount + block.headingCount * 2 + block.codeBlockCount;
    score -= block.linkDensity * 10;
    return score;
  }
}

// --- AI Content Reviewer (Stub, for future AI integration) ---
export class AIContentReviewer {
  async reviewAmbiguousBlocks(blocks) {
    // Placeholder: always keep all blocks
    return { remove: [] };
  }
}

// --- Content Assembler ---
import TurndownService from 'turndown';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkStringify from 'remark-stringify';
import remarkReferenceLinks from 'remark-reference-links';

export class ContentAssembler {
  constructor() {
    this.turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  }
  assembleContent(blocks, cleanHtml) {
    // Convert each block's HTML to markdown, fallback to cleanHtml if empty
    if (!blocks || blocks.length === 0) {
      return this.turndown.turndown(cleanHtml);
    }
    const mdBlocks = blocks.map(b => this.turndown.turndown(b.html || b.textSample || ''));
    let markdown = mdBlocks.join('\n\n');
    // Use remark to convert inline links to reference-style links
    markdown = remark()
      .use(remarkReferenceLinks)
      .use(remarkStringify, { bullet: '-', fences: true })
      .processSync(markdown)
      .toString();
    return markdown;
  }
}


// --- Main HTML Processor Pipeline ---
export class HTMLProcessor {
  constructor(config = {}) {
    this.metadataExtractor = new MetadataExtractor();
    this.navigationRemover = new NavigationRemover();
    this.blockAnalyzer = new ContentBlockAnalyzer();
    this.aiReviewer = new AIContentReviewer();
    this.contentAssembler = new ContentAssembler();
    this.config = { useAI: false, ...config };
  }
  async processPage(html, url) {
    const metadata = this.metadataExtractor.extractPageContext(html, url);
    const cleanHtml = this.navigationRemover.removeAllNavigation(html);
    const filteredBlocks = this.blockAnalyzer.analyzeContentBlocks(cleanHtml);
    let finalBlocks = filteredBlocks;
    if (this.config.useAI && filteredBlocks.length > 0) {
      const aiDecision = await this.aiReviewer.reviewAmbiguousBlocks(filteredBlocks);
      finalBlocks = filteredBlocks.filter((_, i) => !aiDecision.remove.includes(i));
    }
    const markdownBody = this.contentAssembler.assembleContent(finalBlocks, cleanHtml);
    const markdown = matter.stringify(markdownBody, metadata);
    return {
      metadata,
      markdown,
      stats: {
        filteredBlocks: filteredBlocks.length,
        finalBlocks: finalBlocks.length,
        aiUsed: this.config.useAI,
        processingMethod: 'two-stage-pipeline'
      }
    };
  }
}

// --- Metadata-Only Interface ---
export class MetadataOnlyExtractor {
  constructor() { this.metadataExtractor = new MetadataExtractor(); }
  extractMetadata(html, url) { return this.metadataExtractor.extractPageContext(html, url); }
}

// --- Content-Only Interface ---
export class ContentOnlyProcessor {
  constructor(config = {}) {
    this.navigationRemover = new NavigationRemover();
    this.blockAnalyzer = new ContentBlockAnalyzer();
    this.aiReviewer = new AIContentReviewer();
    this.contentAssembler = new ContentAssembler();
    this.config = { useAI: false, ...config };
  }
  async extractContent(html, useAI = true) {
    const cleanHtml = this.navigationRemover.removeAllNavigation(html);
    const filteredBlocks = this.blockAnalyzer.analyzeContentBlocks(cleanHtml);
    let finalBlocks = filteredBlocks;
    if (useAI && filteredBlocks.length > 0) {
      const aiDecision = await this.aiReviewer.reviewAmbiguousBlocks(filteredBlocks);
      finalBlocks = filteredBlocks.filter((_, i) => !aiDecision.remove.includes(i));
    }
    return this.contentAssembler.assembleContent(finalBlocks, cleanHtml);
  }
}
