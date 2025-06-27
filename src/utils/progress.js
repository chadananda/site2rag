import cliProgress from 'cli-progress';
import boxen from 'boxen';
import chalk from 'chalk';
import figlet from 'figlet';
import {readFileSync} from 'fs';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import debugLogger from '../services/debug_logger.js';

/**
 * Service for displaying crawl progress in the CLI
 */
export class ProgressService {
  constructor(options = {}) {
    this.options = options;
    // Get package version
    this.version = this.getPackageVersion();
    // Check if we're in test/log mode
    this.testMode = options.testMode || false;
    // Also check if file logging is active
    this.fileLoggingActive = false;
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
    // Use 2/3 of available width for the progress bar to align with header
    const minBarSize = 35; // Minimum size for small terminals (increased by 15%)
    const maxBarSize = Math.floor((((terminalWidth - 25) * 2) / 3) * 1.15); // 2/3 of available width + 15%
    const barSize = Math.max(minBarSize, maxBarSize);
    
    // Check if we're in a TTY environment
    const isInteractive = process.stderr.isTTY && !process.env.CI;

    // Create multibar container with simplified format
    // Use full-width progress bar with minimal text
    this.multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: isInteractive,
        // Colorful format with percentage and URL count - using bold for better visibility
        // Add extra padding to ensure the total count is fully visible
        format: `${chalk.cyan.bold('{bar}')} ${chalk.green.bold('{percentage}%')} | ${chalk.yellow.bold('{value}')}${chalk.gray('/')}${chalk.yellow.bold('{total}')}   `,
        // Use single blocks for full-width progress bar
        barCompleteChar: '█', // Full block
        barIncompleteChar: '░', // Light shade
        barsize: barSize,
        forceRedraw: false,
        emptyOnZero: false,
        autopadding: true,
        etaBuffer: 10,
        fps: isInteractive ? 10 : 1,
        stream: process.stderr,
        noTTYOutput: !isInteractive,
        notTTYSchedule: 5000
      },
      cliProgress.Presets.shades_classic
    );

    // Create individual progress bars
    this.totalProgress = null;
    this.activeDownloads = new Map();
    // Dual progress bar support
    this.crawlBar = null;
    this.aiBar = null;
    this.dualMode = false;

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
    // Store the maxPages limit to cap the progress bar total
    this.maxPages = initialStats.maxPages || null;

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
        debugLogger.progress(`Setting totalUrls to ${initialStats.totalUrls}, maxPages: ${this.maxPages}`);
      }
    }

    // Display the site URL being processed
    const siteUrl = initialStats.siteUrl || 'Unknown site';
    if (this.isReCrawl) {
      console.log(chalk.blue(`\nUpdating site download: ${chalk.bold(siteUrl)}\n`));
    } else {
      console.log(chalk.green(`\nDownloading site: ${chalk.bold(siteUrl)}\n`));
    }
    
    // In test mode, skip progress bars entirely
    if (this.testMode) {
      // Don't create multibar or any progress bars
      this.multibar = null;
      this.crawlBar = null;
      this.aiBar = null;
      this.isActive = false;
      return;
    }
    
    // Check if we're in a TTY environment
    // We'll try to use progress bars even in non-TTY if we can write to stderr
    const canUseProgressBars = process.stderr.isTTY || (process.stderr && process.stderr.write);
    
    // Only fall back to simple logging if we really can't output to stderr
    if (!canUseProgressBars) {
      this.multibar = null;
      this.crawlBar = null;
      this.aiBar = null;
      this.nonTTYMode = true;
      this.lastProgressLog = Date.now();
      
      // Set up simple progress logging interval
      this.progressLogInterval = setInterval(() => {
        const crawlProgress = this.maxPages 
          ? `Crawl: ${this.stats.crawledUrls}/${this.maxPages} pages`
          : `Crawl: ${this.stats.crawledUrls} pages`;
        const aiProgress = `AI: ${this.stats.aiEnhanced} enhanced`;
        console.log(chalk.dim(`Progress: ${crawlProgress}, ${aiProgress}`));
      }, 5000); // Log every 5 seconds
      
      return;
    }
    
    // Clear any previous progress bars
    if (process.stdout.isTTY) {
      process.stdout.write('\x1B[?25l'); // Hide cursor
    }

    // Create dual progress bars
    const terminalWidth = process.stdout.columns || 80;
    // Make bars shorter to fit with labels and values
    const barSize = Math.min(42, Math.max(20, Math.floor((terminalWidth - 40) * 0.5)));

    this.dualMode = true;
    
    // Create multibar container with proper terminal handling
    this.multibar = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true, // Always true in TTY mode
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      stopOnComplete: false,
      forceRedraw: false, // Don't force redraw on every update
      linewrap: false,
      stream: process.stderr, // Use stderr for progress bars
      gracefulExit: true,
      noTTYOutput: false, // Disable non-TTY output in TTY mode
      fps: 10 // 10 FPS for smooth updates
    }, cliProgress.Presets.shades_classic);
    
    // Always start with the initial total (usually 1 for the starting URL)
    const total = this.stats.totalUrls || 1;
    
    // Simple, clean approach - just two progress bars with clear labels
    console.log(''); // Space after "Downloading site:"
    
    // Create crawl progress bar
    this.crawlBar = this.multibar.create(total, 0, {}, {
      format: `${chalk.cyan.bold('Crawling:')} ${chalk.cyan.bold('{bar}')} ${chalk.green.bold('{percentage}%')} | ${chalk.yellow.bold('{value}')}/${chalk.yellow.bold('{total}')} pages`,
      barsize: barSize
    });
    
    // Create AI progress bar with dynamic token info
    // Store initial token info in instance for the formatter to access
    this.aiTokenInfo = chalk.cyan('0 tokens | $0.00');
    
    this.aiBar = this.multibar.create(100, 0, {
      tokenInfo: this.aiTokenInfo
    }, {
      format: (options, params, payload) => {
        const bar = options.barCompleteChar.repeat(Math.round(params.progress * options.barsize)) + 
                   options.barIncompleteChar.repeat(options.barsize - Math.round(params.progress * options.barsize));
        const percentage = Math.floor(params.progress * 100);
        const tokenInfo = payload.tokenInfo || this.aiTokenInfo;
        return `${chalk.magenta.bold('AI:      ')} ${chalk.magenta.bold(bar)} ${chalk.green.bold(percentage + '%')} | ${tokenInfo}`;
      },
      barsize: barSize
    });

    if (process.env.DEBUG) {
      debugLogger.progress(`Starting dual progress bars - initial totalUrls: ${total}`);
    }

    // Start the update interval to refresh the progress bar based on real progress
    this.updateInterval = setInterval(() => {
      if (this.crawlBar) {
        // Update the total based on discovered URLs or max pages
        const discoveredTotal = Math.max(this.stats.totalUrls, this.stats.crawledUrls + this.stats.queuedUrls);
        let targetTotal = discoveredTotal || 1;

        // If maxPages is set, use it as the total
        if (this.maxPages) {
          targetTotal = this.maxPages;
        }

        // Update the total if it has changed
        if (targetTotal !== this.crawlBar.total && targetTotal > 0) {
          this.crawlBar.setTotal(targetTotal);
        }

        // Update with the actual number of crawled URLs, but don't exceed the total
        const crawledCount = Math.min(this.stats.crawledUrls, targetTotal);
        this.crawlBar.update(crawledCount);
      }
      
      // AI bar will be updated through updateProcessing calls
    }, 100); // Update every 100ms
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
        chalk.hex('#FF8C00')(`Version ${this.version} | https://github.com/chadananda/site${chalk.yellow('2')}rag`),
      {
        padding: 1,
        margin: 0, // Remove margin to align with progress bars
        borderStyle: 'double',
        borderColor: 'red',
        backgroundColor: '#111',
        textAlignment: 'center', // Center text inside the box
        float: 'left' // Keep box left-aligned
      }
    );

    // Display the header
    console.log(header);
  }

  /**
   * Start AI processing progress bar (second phase)
   * @param {number} totalRequests - Total number of AI requests to process
   * @param {Object} aiConfig - AI configuration object with provider and model
   */
  startProcessing(totalRequests, aiConfig) {
    // Store AI config for later use
    this.lastAIConfig = aiConfig;
    
    // In test mode, just log the info
    if (this.testMode) {
      if (aiConfig) {
        const provider = aiConfig.provider || aiConfig.fallbackName || 'unknown';
        const model = aiConfig.model || 'default';
        console.log(chalk.dim(`Starting AI processing: ${totalRequests} requests using ${provider}/${model}`));
      }
      return;
    }
    
    // In dual mode, just update the existing AI bar
    if (this.aiBar) {
      this.aiBar.setTotal(totalRequests);
      // Don't change the format - it's already set properly in start()
      // The token info will be updated via updateProcessing calls
      return;
    }
    
    // Legacy single bar mode (fallback)
    // Clean up download progress bar first
    if (this.multibar) {
      this.multibar.stop();
      this.multibar = null;
    }

    // Clear the line and move cursor up to overwrite any leftover progress bar artifacts
    process.stdout.write('\x1b[2K\r'); // Clear current line
    process.stdout.write('\x1b[1A'); // Move up one line
    process.stdout.write('\x1b[2K\r'); // Clear that line too

    // Display AI provider and model information
    let aiInfo = 'AI enhancement';
    if (aiConfig) {
      const provider = aiConfig.provider || aiConfig.fallbackName || 'unknown';
      const model = aiConfig.model || 'default';
      aiInfo = `AI enhancement using ${chalk.cyan(provider)}/${chalk.cyan(model)}`;
    }

    console.log(chalk.blue(`\nPreparing content for ${aiInfo}:\n`));

    // Create new progress bar for processing
    const terminalWidth = process.stdout.columns || 80;
    const barSize = Math.max(35, Math.floor((((terminalWidth - 25) * 2) / 3) * 1.15));

    this.multibar = new cliProgress.SingleBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: `${chalk.magenta.bold('{bar}')} ${chalk.green.bold('{percentage}%')} | ${chalk.yellow.bold('{value}')}${chalk.gray('/')}${chalk.yellow.bold('{total}')} AI requests`,
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

    this.multibar.start(totalRequests, 0);
  }

  /**
   * Update processing progress
   * @param {number} current - Current AI request completed
   * @param {number} total - Total AI requests
   * @param {Object} tokenData - Token usage data {totalTokens, totalCost}
   */
  updateProcessing(current, total, tokenData = null) {
    // In test mode, log progress updates
    if (this.testMode) {
      if (tokenData) {
        const costStr = tokenData.totalCost ? `$${tokenData.totalCost.toFixed(2)}` : '$0.00';
        const tokenStr = tokenData.totalTokens ? tokenData.totalTokens.toLocaleString() : '0';
        console.log(chalk.dim(`AI Progress: ${current}/${total} - Tokens: ${tokenStr}, Cost: ${costStr}`));
      } else {
        console.log(chalk.dim(`AI Progress: ${current}/${total}`));
      }
      return;
    }
    
    if (this.aiBar) {
      // Update total if it has changed (for dynamic progress tracking)
      if (total && total !== this.aiBar.total) {
        this.aiBar.setTotal(total);
      }
      
      // Format token data for inline display
      let tokenInfo = chalk.cyan('0 tokens | $0.00');
      
      if (tokenData) {
        const costStr = tokenData.totalCost ? `$${tokenData.totalCost.toFixed(2)}` : '$0.00';
        const tokenStr = tokenData.totalTokens ? tokenData.totalTokens.toLocaleString() : '0';
        tokenInfo = chalk.cyan(`${tokenStr} tokens | ${costStr}`);
      }
      
      // Store token info for the formatter
      this.aiTokenInfo = tokenInfo;
      
      // Update the AI bar with token info
      this.aiBar.update(current, { tokenInfo });
    } else if (this.multibar) {
      // Legacy single bar mode
      // Update total if it has changed (for dynamic progress tracking)
      if (total && total !== this.multibar.total) {
        this.multibar.setTotal(total);
      }
      this.multibar.update(current);

      // Force a render to ensure the progress bar is visible
      if (this.multibar.render) {
        this.multibar.render();
      }
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

    // Only show completion message if AI processing actually happened
    if (this.stats.aiEnhanced > 0 || this.stats.aiFailed > 0) {
      console.log(`\n${chalk.green('✓')} ${chalk.green('AI processing completed successfully!')}\n`);
    }
  }

  /**
   * Stop the progress display
   */
  stop() {
    if (!this.isActive) return;

    // Mark as inactive first to prevent any updates during cleanup
    this.isActive = false;
    
    // In test mode, just log completion
    if (this.testMode) {
      if (this.isReCrawl) {
        console.log(chalk.dim(`Re-crawl completed: ${this.stats.newPages} new, ${this.stats.updatedPages} updated, ${this.stats.unchangedPages} unchanged`));
      } else {
        console.log(chalk.dim(`Crawl completed: ${this.stats.crawledUrls} pages downloaded`));
      }
      return;
    }
    
    // In non-TTY mode, show final summary
    if (this.nonTTYMode) {
      if (this.isReCrawl) {
        console.log(`\n✓ Re-crawl completed successfully! ${this.stats.newPages} new, ${this.stats.updatedPages} updated, ${this.stats.unchangedPages} unchanged, ${this.stats.crawledUrls} total pages\n`);
      } else {
        console.log(`\n✓ Download completed successfully! Downloaded ${this.stats.crawledUrls} pages\n`);
      }
      return;
    }

    // Stop all intervals
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    if (this.progressLogInterval) {
      clearInterval(this.progressLogInterval);
      this.progressLogInterval = null;
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
        if (this.crawlBar) {
          // Update crawl bar to final state
          const finalTotal = this.stats.crawledUrls;
          this.crawlBar.setTotal(finalTotal);
          this.crawlBar.update(finalTotal);
        }
        
        // Stop the multibar container
        this.multibar.stop();
        this.multibar = null;
        
        // Show cursor again
        if (process.stdout.isTTY) {
          process.stdout.write('\x1B[?25h'); // Show cursor
        }
        
        // Add a small delay to ensure progress bars are fully cleared
        process.nextTick(() => {
          // Print completion message after bars are gone
          if (this.isReCrawl) {
            // Normal re-crawl logic
            const actualTotal = this.stats.newPages + this.stats.updatedPages + this.stats.unchangedPages;
            console.log(
              `\n✓ Re-crawl completed successfully! ${this.stats.newPages} new, ${this.stats.updatedPages} updated, ${this.stats.unchangedPages} unchanged, ${actualTotal} total pages\n`
            );
          } else {
            console.log(`\n✓ Download completed successfully! Downloaded ${this.stats.crawledUrls} pages\n`);
          }
        });
      } catch (e) {
        if (process.env.DEBUG === 'true') {
          debugLogger.debug('DEBUG', `Error stopping progress bar: ${e.message}`);
        }
      }
    } else {
      // No progress bars, print immediately
      if (this.isReCrawl) {
        const actualTotal = this.stats.newPages + this.stats.updatedPages + this.stats.unchangedPages;
        console.log(
          `\n✓ Re-crawl completed successfully! ${this.stats.newPages} new, ${this.stats.updatedPages} updated, ${this.stats.unchangedPages} unchanged, ${actualTotal} total pages\n`
        );
      } else {
        console.log(`\n✓ Download completed successfully! Downloaded ${this.stats.crawledUrls} pages\n`);
      }
    }
  }

  /**
   * Display the completion message
   */
  displayCompletionMessage() {
    // Only log debug information when DEBUG environment variable is set
    if (process.env.DEBUG === 'true') {
      debugLogger.debug('DEBUG', `isReCrawl: ${this.isReCrawl}`);
      debugLogger.debug(
        'DEBUG',
        `Stats: newPages=${this.stats.newPages}, updatedPages=${this.stats.updatedPages}, unchangedPages=${this.stats.unchangedPages}`
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
    // In test mode, log significant updates
    if (this.testMode) {
      if (stats.crawledUrls !== undefined && stats.crawledUrls !== this.stats.crawledUrls) {
        console.log(chalk.dim(`Crawl Progress: ${stats.crawledUrls}/${stats.totalUrls || '?'} pages`));
      }
      // Update internal stats but skip all progress bar updates
      if (stats.totalUrls !== undefined) this.stats.totalUrls = stats.totalUrls;
      if (stats.crawledUrls !== undefined) this.stats.crawledUrls = stats.crawledUrls;
      if (stats.queuedUrls !== undefined) this.stats.queuedUrls = stats.queuedUrls;
      if (stats.activeUrls !== undefined) this.stats.activeUrls = stats.activeUrls;
      return;
    }
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
    if (this.crawlBar && this.stats.totalUrls !== oldTotalUrls) {
      // Update the crawl bar total
      const newTotal = this.stats.totalUrls > 0 ? this.stats.totalUrls : 1;
      this.crawlBar.setTotal(newTotal);
    }
    
    // Update crawl bar progress
    if (this.crawlBar) {
      this.crawlBar.update(this.stats.crawledUrls);
    }

    // Update total progress bar if it exists (legacy single bar mode)
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
