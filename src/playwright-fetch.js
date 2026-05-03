// Playwright browser pool for JS-rendered pages. Exports: createPlaywrightPool, isHtmlShell. Deps: playwright
import { chromium } from 'playwright';

const SHELL_WORD_THRESHOLD = 100;
const CONTENT_RATIO_THRESHOLD = 3;

/** Count meaningful words in HTML after stripping tags, scripts, styles. */
export const extractTextWordCount = (html) => {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 2).length;
};

/** Returns true if the HTML has too little text to be useful — likely a JS shell. */
export const isHtmlShell = (html) => extractTextWordCount(html) < SHELL_WORD_THRESHOLD;

/** Returns true if rendered HTML has substantially more content than the static version. */
export const isWorthRendering = (staticHtml, renderedHtml) => {
  const staticWords = extractTextWordCount(staticHtml);
  const renderedWords = extractTextWordCount(renderedHtml);
  return renderedWords > staticWords * CONTENT_RATIO_THRESHOLD && renderedWords > SHELL_WORD_THRESHOLD;
};

/**
 * Create a Playwright browser pool for rendering JS-heavy pages.
 * The pool manages a single browser instance with sequential page renders.
 * @param {object} options
 * @param {string} [options.wait_selector] CSS selector to wait for before extracting HTML
 * @param {number} [options.timeout_ms=20000] Navigation timeout
 * @returns {object} { render(url): Promise<string>, close(): Promise<void> }
 */
export const createPlaywrightPool = async (options = {}) => {
  const timeout = options.timeout_ms ?? 20000;
  const waitSelector = options.wait_selector ?? null;
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.warn('[playwright] failed to launch browser:', err.message);
    return null;
  }

  return {
    async render(url) {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout });
        if (waitSelector) {
          await page.waitForSelector(waitSelector, { timeout: 5000 }).catch(() => {});
        }
        return await page.content();
      } finally {
        await page.close();
      }
    },
    async close() {
      await browser.close().catch(() => {});
    }
  };
};
