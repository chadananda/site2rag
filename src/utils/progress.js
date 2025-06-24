import cliProgress from 'cli-progress';
import boxen from 'boxen';
import chalk from 'chalk';
import figlet from 'figlet';
import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';

/**
 * Service for displaying crawl progress in the CLI
 */
export class ProgressService {
  constructor(options = {}) {
    this.options = options;
    // Get package version
    this.version = this.getPackageVersion();
    this.stats = {
      totalUrls: 0,
      crawledUrls: 0,
      queuedUrls: 0,
      activeUrls: 0,
      assets: {
        total: 0,
        images: 0,
        documents: 0,
        other: 0
      },
      errors: {
        total: 0,
        retries: 0
      },
      startTime: null,
      currentUrls: [],
      // Detailed stats for re-crawls
      newPages: 0,
      updatedPages: 0,
      unchangedPages: 0,
      // AI enhancement tracking
      aiEnhanced: 0, // Pages successfully AI-enhanced
      aiPending: 0, // Pages queued for AI enhancement
      aiRateLimited: 0, // AI requests rate-limited
      aiFailed: 0 // AI enhancement failures
    };

    // Figlet options for header display
    this.figletOptions = {
      font: options.figletFont || 'ANSI Shadow',
      horizontalLayout: 'default',
      verticalLayout: 'default',
      width: 80,
      whitespaceBreak: true
    };

    // Update frequency in milliseconds
    this.updateFrequency = options.updateFrequency || 100;

    // Track last stats update time to avoid too frequent updates
    this.lastStatsUpdate = 0;

    // Get terminal width for full-width progress bar
    const terminalWidth = process.stdout.columns || 80;
    // Use full terminal width for the progress bar, just reserve space for text
    const minBarSize = 40; // Minimum size for small terminals
    const maxBarSize = terminalWidth - 25; // Reserve space for percentage and count
    const barSize = Math.max(minBarSize, maxBarSize);

    // Create multibar container with simplified format
    // Use full-width progress bar with minimal text
    this.multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        // Colorful format with percentage and URL count - using bold for better visibility
        // Add extra padding to ensure the total count is fully visible
        format: `${chalk.cyan.bold('{bar}')} ${chalk.green.bold('{percentage}%')} | ${chalk.yellow.bold('{value}')}${chalk.gray('/')}${chalk.yellow.bold('{total}')}   `,
        // Use single blocks for full-width progress bar
        barCompleteChar: '█', // Full block
        barIncompleteChar: '░', // Light shade
        barsize: barSize,
        forceRedraw: true,
        emptyOnZero: false,
        autopadding: true,
        etaBuffer: 10,
        fps: 10
      },
      cliProgress.Presets.shades_classic
    );

    // Create individual progress bars
    this.totalProgress = null;
    this.activeDownloads = new Map();

    this.isActive = false;
    this.updateInterval = null;
    this.updateFrequency = options.updateFrequency || 500; // Update every 500ms
    this.isReCrawl = false;
  }

  /**
   * Get package version from package.json
   * @returns {string} Package version
   */
  getPackageVersion() {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const packagePath = join(__dirname, '../../package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      return packageJson.version;
    } catch {
      return '0.4.0'; // fallback version
    }
  }

  /**
   * Start the progress display
   * @param {Object} initialStats - Initial statistics
   */
  start(initialStats = {}) {
    // If already active, stop first to clean up any existing progress bars
    if (this.isActive) {
      this.stop();
    }

    this.isActive = true;
    this.stats.startTime = Date.now();
    this.isReCrawl = initialStats.isReCrawl || false;

    // Initialize re-crawl statistics if applicable
    if (initialStats.isReCrawl) {
      this.isReCrawl = true;
      this.stats.newPages = 0;
      this.stats.updatedPages = 0;
      this.stats.unchangedPages = 0;
    }

    // Set initial stats if provided
    if (initialStats.totalUrls !== undefined) {
      this.stats.totalUrls = initialStats.totalUrls;
      // Debug log
      if (process.env.DEBUG) {
        console.log(`[PROGRESS] Setting totalUrls to ${initialStats.totalUrls}`);
      }
    }

    // Display the figlet header
    this.displayHeader();

    // Display the site URL being processed
    const siteUrl = initialStats.siteUrl || 'Unknown site';
    if (this.isReCrawl) {
      console.log(chalk.blue(`\nUpdating site download: ${chalk.bold(siteUrl)}\n`));
    } else {
      console.log(chalk.green(`\nDownloading site: ${chalk.bold(siteUrl)}\n`));
    }

    // Create a single-bar instance instead of multibar to avoid double line issues
    const terminalWidth = process.stdout.columns || 80;
    const barSize = Math.max(40, terminalWidth - 25);

    this.multibar = new cliProgress.SingleBar(
      {
        clearOnComplete: false, // Don't clear on complete to keep the final state visible
        hideCursor: true,
        format: `${chalk.cyan.bold('{bar}')} ${chalk.green.bold('{percentage}%')} | ${chalk.yellow.bold('{value}')}${chalk.gray('/')}${chalk.yellow.bold('{total}')}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        barsize: barSize,
        stopOnComplete: false, // Don't stop on complete to keep the bar visible
        forceRedraw: true
      },
      cliProgress.Presets.shades_classic
    );

    // Start the progress bar
    // For unlimited crawls (totalUrls <= 0), show as 'unlimited' in the progress bar
    // This will be updated dynamically as URLs are discovered
    const total = this.stats.totalUrls > 0 ? this.stats.totalUrls : 1000; // Use larger placeholder
    this.multibar.start(total, 0);

    // Start the update interval to refresh the progress bar based on real progress
    this.updateInterval = setInterval(() => {
      if (this.multibar) {
        // Update with the actual number of crawled URLs
        this.multibar.update(this.stats.crawledUrls);
      }
    }, 100); // Update every 100ms for smooth animation
  }

  /**
   * Display the figlet header
   */
  displayHeader() {
    // Clear the console first
    console.clear();

    // Create separate figlet texts for 'Site' and 'RAG'
    const siteFiglet = figlet.textSync('Site', this.figletOptions);
    const twoFiglet = figlet.textSync('2', this.figletOptions);
    const ragFiglet = figlet.textSync('RAG', this.figletOptions);

    // Split the texts into lines
    const siteLines = siteFiglet.split('\n');
    const twoLines = twoFiglet.split('\n');
    const ragLines = ragFiglet.split('\n');

    // Combine the lines with the '2' colored differently
    const combinedLines = [];
    for (let i = 0; i < siteLines.length; i++) {
      // Ensure we don't go out of bounds
      if (i >= twoLines.length || i >= ragLines.length) continue;

      // Combine the line parts with the '2' colored in yellow
      combinedLines.push(siteLines[i] + chalk.yellow(twoLines[i]) + ragLines[i]);
    }

    // Create a fiery gradient effect
    const lines = combinedLines;
    const coloredLines = lines.map((line, i) => {
      // Create a gradient from red to yellow based on line position
      if (i < lines.length / 3) {
        return chalk.red(line); // Top third: red
      } else if (i < (lines.length * 2) / 3) {
        return chalk.hex('#FF8C00')(line); // Middle third: dark orange
      } else {
        return chalk.yellow(line); // Bottom third: yellow
      }
    });

    // Create the header box with centered content but left-aligned box
    const header = boxen(
      coloredLines.join('\n') +
        '\n\n' +
        chalk.cyan('🔥 Website to RAG Knowledge Base Converter 🔥') +
        '\n' +
        chalk.white('Converting web content to AI-ready markdown with intelligent crawling') +
        '\n' +
        chalk.hex('#FF8C00')(
          `Version ${this.version} | https://github.com/chadananda/site${chalk.yellow('2')}rag`
        ),
      {
        padding: 1,
        margin: 1,
        borderStyle: 'double',
        borderColor: 'red',
        backgroundColor: '#111',
        textAlignment: 'center', // Center text inside the box
        float: 'left', // Keep box left-aligned
        align: 'center'
      }
    );

    // Display the header
    console.log(header);
  }

  /**
   * Start AI processing progress bar (second phase)
   * @param {number} totalDocuments - Total number of documents to process
   */
  startProcessing(totalDocuments) {
    // Clean up download progress bar first
    if (this.multibar) {
      this.multibar.stop();
      this.multibar = null;
    }

    // Clear the line and move cursor up to overwrite any leftover progress bar artifacts
    process.stdout.write('\x1b[2K\r'); // Clear current line
    process.stdout.write('\x1b[1A');    // Move up one line
    process.stdout.write('\x1b[2K\r'); // Clear that line too
    
    console.log(chalk.blue(`\nProcessing content with AI enhancement:\n`));

    // Create new progress bar for processing
    const terminalWidth = process.stdout.columns || 80;
    const barSize = Math.max(40, terminalWidth - 25);

    this.multibar = new cliProgress.SingleBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: `${chalk.magenta.bold('{bar}')} ${chalk.green.bold('{percentage}%')} | ${chalk.yellow.bold('{value}')}${chalk.gray('/')}${chalk.yellow.bold('{total}')} ${chalk.cyan('{url}')}`,
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        barsize: barSize,
        stopOnComplete: false,
        forceRedraw: true,
        linewrap: false,
        gracefulExit: true
      },
      cliProgress.Presets.shades_classic
    );

    this.multibar.start(totalDocuments, 0, { url: 'Starting...' });
  }

  /**
   * Update processing progress
   * @param {number} current - Current document being processed
   * @param {number} total - Total documents
   * @param {string} url - Current URL being processed
   */
  updateProcessing(current, total, url) {
    if (this.multibar) {
      // Truncate long URLs for display
      const displayUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
      this.multibar.update(current, { url: displayUrl });
    }
  }

  /**
   * Complete processing phase
   */
  completeProcessing() {
    if (this.multibar) {
      this.multibar.stop();
      this.multibar = null;
    }
    
    console.log(`\n${chalk.green('✓')} ${chalk.green('AI processing completed successfully!')}\n`);
  }

  /**
   * Stop the progress display
   */
  stop() {
    if (!this.isActive) return;

    // Mark as inactive first to prevent any updates during cleanup
    this.isActive = false;

    // Stop all intervals
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Clear all active downloads
    this.activeDownloads.clear();

    // No need to hardcode values - we'll use the actual crawled URLs count

    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    if (this.multibar) {
      try {
        // Update total to match actual crawled count for final display
        // For unlimited crawls or when discovered URLs differ from initial estimate
        if (this.stats.crawledUrls > 0) {
          const finalTotal = this.stats.crawledUrls;
          if (this.multibar.setTotal) {
            this.multibar.setTotal(finalTotal);
          } else {
            this.multibar.total = finalTotal;
          }
          this.multibar.update(finalTotal);
        }
        this.multibar.stop();
        if (process.stdout.isTTY) {
          if (process.stdout.clearLine && process.stdout.cursorTo) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
          }
        }
      } catch (e) {
        if (process.env.DEBUG === 'true') {
          console.log(`[DEBUG] Error stopping progress bar: ${e.message}`);
        }
      }
    }

    this.multibar = null;

    if (this.isReCrawl) {
      // Normal re-crawl logic
      const actualTotal = this.stats.newPages + this.stats.updatedPages + this.stats.unchangedPages;
      console.log(
        `\n✓ Re-crawl completed successfully! ${this.stats.newPages} new, ${this.stats.updatedPages} updated, ${this.stats.unchangedPages} unchanged, ${actualTotal} total pages\n`
      );
    } else {
      console.log(`\n✓ Download completed successfully! Downloaded ${this.stats.crawledUrls} pages\n`);
    }
  }

  /**
   * Display the completion message
   */
  displayCompletionMessage() {
    // Only log debug information when DEBUG environment variable is set
    if (process.env.DEBUG === 'true') {
      console.log(`[DEBUG] isReCrawl: ${this.isReCrawl}`);
      console.log(
        `[DEBUG] Stats: newPages=${this.stats.newPages}, updatedPages=${this.stats.updatedPages}, unchangedPages=${this.stats.unchangedPages}`
      );
    }

    // Create a single, clean completion message
    let message;
    if (this.isReCrawl) {
      const newPages = chalk.green(`${this.stats.newPages} new`);
      const updatedPages = chalk.yellow(`${this.stats.updatedPages} updated`);
      const unchangedPages = chalk.gray(`${this.stats.unchangedPages} unchanged`);
      const totalPages = chalk.white(`${this.stats.crawledUrls} total`);

      // Use a checkmark emoji with colored text for the completion message
      const checkmark = chalk.green('✓');
      message = `${checkmark} ${chalk.blue('Re-crawl completed successfully!')} ${newPages}, ${updatedPages}, ${unchangedPages}, ${totalPages} pages`;
    } else {
      const checkmark = chalk.green('✓');
      message = `${checkmark} ${chalk.green('Download completed successfully!')} Downloaded ${chalk.bold(this.stats.crawledUrls)} pages`;
    }

    // Ensure we're at the start of a clean line
    if (process.stdout.clearLine && process.stdout.cursorTo) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }

    // Print the completion message with blank lines above and below for readability
    console.log('\n' + message + '\n');
  }

  /**
   * Update crawl statistics
   * @param {Object} stats - Updated statistics
   */
  updateStats(stats) {
    // Update stats with new values
    const oldTotalUrls = this.stats.totalUrls;
    if (stats.totalUrls !== undefined) this.stats.totalUrls = stats.totalUrls;
    if (stats.crawledUrls !== undefined) this.stats.crawledUrls = stats.crawledUrls;
    if (stats.queuedUrls !== undefined) this.stats.queuedUrls = stats.queuedUrls;
    if (stats.activeUrls !== undefined) this.stats.activeUrls = stats.activeUrls;

    // Update assets
    if (stats.assets) {
      if (stats.assets.total !== undefined) this.stats.assets.total = stats.assets.total;
      if (stats.assets.images !== undefined) this.stats.assets.images = stats.assets.images;
      if (stats.assets.documents !== undefined) this.stats.assets.documents = stats.assets.documents;
      if (stats.assets.other !== undefined) this.stats.assets.other = stats.assets.other;
    }

    // Update errors
    if (stats.errors) {
      if (stats.errors.total !== undefined) this.stats.errors.total = stats.errors.total;
      if (stats.errors.retries !== undefined) this.stats.errors.retries = stats.errors.retries;
    }

    // Update re-crawl specific statistics
    if (this.isReCrawl) {
      if (stats.newPages !== undefined) this.stats.newPages = stats.newPages;
      if (stats.updatedPages !== undefined) this.stats.updatedPages = stats.updatedPages;
      if (stats.unchangedPages !== undefined) this.stats.unchangedPages = stats.unchangedPages;
    }

    // Update AI enhancement statistics
    if (stats.aiEnhanced !== undefined) this.stats.aiEnhanced = stats.aiEnhanced;
    if (stats.aiPending !== undefined) this.stats.aiPending = stats.aiPending;
    if (stats.aiRateLimited !== undefined) this.stats.aiRateLimited = stats.aiRateLimited;
    if (stats.aiFailed !== undefined) this.stats.aiFailed = stats.aiFailed;

    // Update progress bar total if it changed and we have an active progress bar
    if (this.multibar && this.stats.totalUrls !== oldTotalUrls) {
      // For SingleBar, we need to update the total differently
      // Always update the total, even if it's 0 (will use our placeholder of 100)
      const newTotal = this.stats.totalUrls > 0 ? this.stats.totalUrls : 100;
      if (this.multibar.setTotal) {
        this.multibar.setTotal(newTotal);
      } else {
        this.multibar.total = newTotal;
      }
      // Force update to reflect the new total
      this.multibar.update(this.stats.crawledUrls);
    }
    
    // Update total progress bar if it exists (legacy)
    if (this.totalProgress) {
      this.totalProgress.setTotal(this.stats.totalUrls || 100);
      this.totalProgress.update(this.stats.crawledUrls);
    }
  }

  /**
   * Add a URL to the active downloads
   * @param {string} url - URL being downloaded
   */
  addActiveUrl(url) {
    if (!this.isActive) return;

    // With SingleBar, we don't create individual bars for each URL
    // Just track the URL in our active downloads
    if (!this.activeDownloads.has(url)) {
      this.activeDownloads.set(url, {
        progress: 0,
        startTime: Date.now()
      });

      // Add to current URLs list (max 5)
      this.stats.currentUrls.push(url);
      if (this.stats.currentUrls.length > 5) {
        this.stats.currentUrls.shift();
      }

      // Start simulating progress for this URL
      this.simulateUrlProgress(url);
    }
  }

  /**
   * Simulate progress for a specific URL download
   * @param {string} url - URL being downloaded
   */
  simulateUrlProgress(url) {
    if (!this.isActive || !this.activeDownloads.has(url)) return;

    this.activeDownloads.get(url);
    let progress = 0;

    // Create a random interval between 100-300ms for progress updates
    const interval = setInterval(
      () => {
        if (!this.activeDownloads.has(url)) {
          clearInterval(interval);
          return;
        }

        // Calculate a random increment between 5-15%
        const increment = Math.floor(Math.random() * 10) + 5;
        progress = Math.min(95, progress + increment); // Cap at 95% until complete

        // Update the progress bar
        this.updateUrlProgress(url, progress);

        // If we've reached 95%, stop simulating (the complete method will finish it)
        if (progress >= 95) {
          clearInterval(interval);
        }
      },
      Math.floor(Math.random() * 200) + 100
    );
  }

  /**
   * Update the progress of an active download
   * @param {string} url - URL being downloaded
   * @param {number} progress - Download progress (0-100)
   */
  updateUrlProgress(url, progress) {
    if (!this.isActive || !this.activeDownloads.has(url)) return;

    const download = this.activeDownloads.get(url);
    download.progress = progress;

    // With SingleBar, we don't update individual URL progress bars
    // Instead, we just track the progress in our data structure
  }

  /**
   * Complete an active download
   * @param {string} url - URL that completed downloading
   * @param {string} status - Status of the download (success, cached, error)
   */
  completeUrl(url, status = 'success') {
    if (!this.isActive || !this.activeDownloads.has(url)) return;

    // With SingleBar, we don't have individual progress bars for URLs
    // Just track completion in our data structure and update stats

    // Update stats based on status
    this.stats.crawledUrls++;

    switch (status) {
      case 'success':
        this.stats.newPages++;
        break;
      case 'cached':
        // No change to stats for cached pages
        break;
      case 'error':
        this.stats.errors++;
        break;
      case 'unchanged':
        this.stats.unchangedPages++;
        break;
      case 'updated':
        this.stats.updatedPages++;
        break;
    }

    // Remove from active downloads
    this.activeDownloads.delete(url);

    // Remove from current URLs list
    const index = this.stats.currentUrls.indexOf(url);
    if (index !== -1) {
      this.stats.currentUrls.splice(index, 1);
    }

    // Update the main progress bar
    if (this.multibar) {
      this.multibar.update(this.stats.crawledUrls);
    }
  }

  /**
   * Track AI enhancement status for a URL
   * @param {string} url - URL being AI enhanced
   * @param {string} status - Status of enhancement (success, rate_limited, failed, pending)
   */
  trackAIEnhancement(url, status) {
    if (!this.isActive) return;

    switch (status) {
      case 'success':
        this.stats.aiEnhanced++;
        if (this.stats.aiPending > 0) this.stats.aiPending--;
        break;
      case 'rate_limited':
        this.stats.aiRateLimited++;
        if (this.stats.aiPending > 0) this.stats.aiPending--;
        break;
      case 'failed':
        this.stats.aiFailed++;
        if (this.stats.aiPending > 0) this.stats.aiPending--;
        break;
      case 'pending':
        this.stats.aiPending++;
        break;
    }
  }

  /**
   * Get AI enhancement progress percentage
   * @returns {number} AI enhancement completion percentage
   */
  getAIProgress() {
    const totalProcessed = this.stats.aiEnhanced + this.stats.aiRateLimited + this.stats.aiFailed;
    return this.stats.crawledUrls > 0 ? Math.round((totalProcessed / this.stats.crawledUrls) * 100) : 0;
  }

  /**
   * Initialize the progress bar for test scripts
   * This only sets up the initial state but doesn't simulate progress
   */
  initializeTestProgress() {
    if (!this.isActive || !this.multibar) return;

    // Update the progress bar with initial state
    this.multibar.update(0);

    // Set up regular updates to refresh the progress bar
    this.updateInterval = setInterval(() => {
      // Update the progress bar with the current count of crawled URLs
      if (this.multibar) {
        this.multibar.update(this.stats.crawledUrls);
      }
    }, 100); // Update every 100ms for smooth animation
  }

  /**
   * Format a URL for display (truncate if too long)
   * @param {string} url - URL to format
   * @returns {string} - Formatted URL
   */
  formatUrl(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;

      // Truncate if too long
      if (path.length > 40) {
        return `...${path.slice(-37)}`;
      }
      return path || '/';
    } catch {
      return url;
    }
  }

  /**
   * Calculate elapsed time and estimated remaining time
   * @returns {Object} - Time information
   */
  calculateTimeInfo() {
    const elapsedMs = Date.now() - this.stats.startTime;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    // Calculate minutes and seconds
    const minutes = Math.floor(elapsedSec / 60);
    const seconds = elapsedSec % 60;

    // Format elapsed time
    const elapsedStr = `${minutes}m ${seconds}s`;

    // Calculate estimated remaining time
    let remainingStr = 'calculating...';

    if (this.stats.crawledUrls > 0 && this.stats.totalUrls > 0) {
      const percentComplete = this.stats.crawledUrls / this.stats.totalUrls;
      if (percentComplete > 0) {
        const totalEstimatedSec = elapsedSec / percentComplete;
        const remainingSec = Math.max(0, totalEstimatedSec - elapsedSec);

        const remainingMin = Math.floor(remainingSec / 60);
        const remainingSecs = Math.floor(remainingSec % 60);

        remainingStr = `${remainingMin}m ${remainingSecs}s`;
      }
    }

    return {elapsed: elapsedStr, remaining: remainingStr};
  }

  /**
   * Render the progress display
   */
  render() {
    if (!this.isActive || !this.multibar) return;

    // Update the progress bar with current crawled URLs count
    this.multibar.update(this.stats.crawledUrls);
  }

  /**
   * Render a summary of the crawl
   */
  renderSummary() {
    // We don't check isActive here because we want to show the summary even after stopping

    // Calculate time information
    const timeInfo = this.calculateTimeInfo();

    // Create a fiery gradient for the summary header
    const summaryHeader = this.isReCrawl
      ? chalk.bold.hex('#4169E1')('🔄 RE-CRAWL COMPLETE 🔄')
      : chalk.bold.hex('#FF4500')('🔥 CRAWL COMPLETE 🔥');

    // Calculate crawl speed
    const elapsedSec = (Date.now() - this.stats.startTime) / 1000;
    const pagesPerSecond = this.stats.crawledUrls / (elapsedSec || 1); // Avoid division by zero
    const crawlSpeed = pagesPerSecond.toFixed(2);

    // Calculate AI enhancement percentage
    const aiPercentage = this.getAIProgress();

    // Build the summary content
    let summaryContent =
      `${chalk.bold('Pages:')} ${this.stats.crawledUrls} of ${this.stats.totalUrls} processed\n` +
      `${chalk.bold('Assets:')} ${this.stats.assets.total} total (${this.stats.assets.images} images, ${this.stats.assets.documents} documents)\n` +
      `${chalk.bold('Errors:')} ${this.stats.errors.total} (${this.stats.errors.retries} retries)\n` +
      `${chalk.bold('AI Enhanced:')} ${this.stats.aiEnhanced} of ${this.stats.crawledUrls} (${aiPercentage}%)\n` +
      `${chalk.bold('Time:')} ${timeInfo.elapsed} elapsed\n` +
      `${chalk.bold('Speed:')} ${crawlSpeed} pages/second`;

    // Add re-crawl statistics if this is a re-crawl
    if (this.isReCrawl) {
      summaryContent +=
        '\n\n' +
        `${chalk.bold('Re-crawl Stats:')}\n` +
        `${chalk.green('✓')} ${chalk.bold('New:')} ${this.stats.newPages} pages\n` +
        `${chalk.yellow('↻')} ${chalk.bold('Updated:')} ${this.stats.updatedPages} pages\n` +
        `${chalk.gray('=')} ${chalk.bold('Unchanged:')} ${this.stats.unchangedPages} pages`;
    }

    const summary = boxen(summaryHeader + '\n\n' + summaryContent, {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: this.isReCrawl ? 'blue' : 'cyan',
      backgroundColor: '#111'
    });

    // Print the summary with blank lines above and below for readability
    console.log('\n' + summary + '\n');
  }
}

export default ProgressService;
