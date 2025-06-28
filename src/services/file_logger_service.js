/**
 * file_logger_service.js
 * Service for redirecting all debug output to log files when --test flag is used
 */
import fs from 'fs';
import path from 'path';
import {format} from 'util';
/**
 * FileLoggerService - Manages log file creation and console output redirection
 */
export class FileLoggerService {
  constructor() {
    this.logFile = null;
    this.logStream = null;
    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      debug: console.debug
    };
    this.isActive = false;
    this.testMode = false;
  }
  /**
   * Initialize file logging for test mode
   * @param {string} outputDir - Base output directory
   * @param {boolean} testMode - Whether test mode is enabled
   * @returns {string|null} - Path to log file if created
   */
  initialize(outputDir, testMode = false) {
    if (!testMode) {
      return null;
    }
    this.testMode = testMode;
    try {
      // Create logs directory
      const logsDir = path.join(outputDir, '.site2rag', 'logs');
      fs.mkdirSync(logsDir, {recursive: true});
      // Create log file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const logFileName = `site2rag-${timestamp}.log`;
      this.logFile = path.join(logsDir, logFileName);
      // Create write stream
      this.logStream = fs.createWriteStream(this.logFile, {flags: 'a'});
      // Write header
      this.logStream.write(`=== Site2rag Log File ===\n`);
      this.logStream.write(`Started: ${new Date().toISOString()}\n`);
      this.logStream.write(`Test Mode: ${testMode}\n`);
      this.logStream.write(`Output Directory: ${outputDir}\n`);
      this.logStream.write(`${'='.repeat(50)}\n\n`);
      // Redirect console output
      this.redirectConsole();
      this.isActive = true;
      // Log initialization - suppress in test mode
      // File creation is silent in test mode to avoid console clutter
      return this.logFile;
    } catch (error) {
      this.originalConsole.error(`[FILE_LOGGER] Failed to initialize file logging: ${error.message}`);
      return null;
    }
  }
  /**
   * Redirect console methods to log file
   */
  redirectConsole() {
    if (!this.logStream) return;
    // Store original stderr write
    this.originalStderrWrite = process.stderr.write;
    // Helper to write to both file and optionally console
    const createLogger = (method, prefix) => {
      return (...args) => {
        const timestamp = new Date().toISOString();
        const message = format(...args);
        // Write to file
        this.logStream.write(`[${timestamp}] ${prefix} ${message}\n`);
        // In test mode, still show console output for UI elements
        // The --test flag should only affect debug logging to file, not UI
        this.originalConsole[method](...args);
      };
    };
    // Redirect all console methods
    console.log = createLogger('log', '[LOG]');
    console.error = createLogger('error', '[ERROR]');
    console.warn = createLogger('warn', '[WARN]');
    console.debug = createLogger('debug', '[DEBUG]');
    // Also redirect console.info if it exists
    if (console.info) {
      console.info = createLogger('log', '[INFO]');
    }
    // Intercept stderr writes to capture progress bars
    if (this.testMode) {
      process.stderr.write = (chunk, encoding, callback) => {
        // Write to log file
        const timestamp = new Date().toISOString();
        this.logStream.write(`[${timestamp}] [STDERR] ${chunk}`);
        // Still write to actual stderr so progress bars appear
        return this.originalStderrWrite.call(process.stderr, chunk, encoding, callback);
      };
    }
  }
  /**
   * Restore original console methods
   */
  restoreConsole() {
    if (!this.isActive) return;
    console.log = this.originalConsole.log;
    console.error = this.originalConsole.error;
    console.warn = this.originalConsole.warn;
    console.debug = this.originalConsole.debug;
    if (console.info) {
      console.info = this.originalConsole.log;
    }
    // Restore stderr.write if it was redirected
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }
  }
  /**
   * Write a message directly to the log file
   * @param {string} message - Message to write
   */
  write(message) {
    if (this.logStream && this.isActive) {
      const timestamp = new Date().toISOString();
      this.logStream.write(`[${timestamp}] ${message}\n`);
    }
  }
  /**
   * Write a separator line to the log file
   * @param {string} label - Optional label for the separator
   */
  writeSeparator(label = '') {
    if (this.logStream && this.isActive) {
      const separator = '='.repeat(50);
      if (label) {
        this.logStream.write(`\n${separator}\n${label}\n${separator}\n\n`);
      } else {
        this.logStream.write(`\n${separator}\n\n`);
      }
    }
  }
  /**
   * Close the log file and restore console
   */
  close() {
    if (!this.isActive) return;
    // Write footer
    if (this.logStream) {
      this.writeSeparator('End of Log');
      this.logStream.write(`Ended: ${new Date().toISOString()}\n`);
      this.logStream.end();
      this.logStream = null;
    }
    // Restore console
    this.restoreConsole();
    this.isActive = false;
    // Final message suppressed in test mode to avoid console clutter
    // Log file path is already known from initialization
  }
  /**
   * Get the current log file path
   * @returns {string|null} - Path to log file or null if not active
   */
  getLogFile() {
    return this.isActive ? this.logFile : null;
  }
}
// Create singleton instance
export const fileLogger = new FileLoggerService();
export default fileLogger;