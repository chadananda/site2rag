import fs from 'fs';
import path from 'path';
import logger from '../services/logger_service.js';

/**
 * Process lock manager to prevent multiple instances from running simultaneously
 */
export class ProcessLock {
  /**
   * Create a process lock
   * @param {string} lockDir - Directory to store lock file
   * @param {string} lockName - Name of the lock file
   */
  constructor(lockDir, lockName = 'site2rag.lock') {
    this.lockPath = path.join(lockDir, lockName);
    this.pid = process.pid;
    this.acquired = false;
  }

  /**
   * Try to acquire the lock
   * @returns {boolean} - True if lock was acquired
   */
  acquire() {
    try {
      // Check if lock file exists
      if (fs.existsSync(this.lockPath)) {
        // Read the PID from the lock file
        const lockPid = parseInt(fs.readFileSync(this.lockPath, 'utf8').trim());
        
        // Check if the process is still running
        if (this.isProcessRunning(lockPid)) {
          logger.warn(`Another instance is already running (PID: ${lockPid})`);
          return false;
        } else {
          // Process is not running, remove stale lock
          logger.info(`Removing stale lock file (PID: ${lockPid} not running)`);
          fs.unlinkSync(this.lockPath);
        }
      }
      
      // Create lock file with our PID
      fs.writeFileSync(this.lockPath, this.pid.toString(), { flag: 'wx' });
      this.acquired = true;
      
      // Set up cleanup handlers
      this.setupCleanupHandlers();
      
      logger.info(`Process lock acquired (PID: ${this.pid})`);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        logger.warn('Lock file already exists - another instance may be running');
        return false;
      }
      logger.error(`Error acquiring process lock: ${error.message}`);
      return false;
    }
  }

  /**
   * Release the lock
   */
  release() {
    if (this.acquired) {
      try {
        fs.unlinkSync(this.lockPath);
        this.acquired = false;
        logger.info('Process lock released');
      } catch (error) {
        logger.error(`Error releasing process lock: ${error.message}`);
      }
    }
  }

  /**
   * Check if a process is running
   * @param {number} pid - Process ID to check
   * @returns {boolean} - True if process is running
   */
  isProcessRunning(pid) {
    try {
      // Send signal 0 to check if process exists
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH means process doesn't exist
      return error.code !== 'ESRCH';
    }
  }

  /**
   * Set up cleanup handlers to release lock on exit
   */
  setupCleanupHandlers() {
    const cleanup = () => {
      this.release();
    };

    // Handle various exit scenarios
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      cleanup();
      process.exit(1);
    });
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      cleanup();
      process.exit(1);
    });
  }
}