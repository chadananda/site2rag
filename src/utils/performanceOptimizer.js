// performanceOptimizer.js
// Performance optimization utilities for site2rag
/**
 * Memory-efficient bounded array implementation
 */
export class BoundedArray {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.maxSize) {
      // Remove oldest items
      this.items = this.items.slice(-this.maxSize);
    }
  }

  get length() {
    return this.items.length;
  }

  toArray() {
    return [...this.items];
  }

  clear() {
    this.items = [];
  }
}
/**
 * Memory-efficient Set with size limit
 */
export class BoundedSet {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.items = new Set();
    this.accessOrder = [];
  }

  add(item) {
    if (this.items.has(item)) {
      return;
    }

    if (this.items.size >= this.maxSize) {
      // Remove least recently accessed
      const toRemove = this.accessOrder.shift();
      this.items.delete(toRemove);
    }

    this.items.add(item);
    this.accessOrder.push(item);
  }

  has(item) {
    return this.items.has(item);
  }

  get size() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
    this.accessOrder = [];
  }

  toArray() {
    return Array.from(this.items);
  }
}
/**
 * Simple LRU cache implementation
 */
export class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    // Remove if exists to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}
/**
 * Batch processor for efficient async operations
 */
export class BatchProcessor {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 10;
    this.flushInterval = options.flushInterval || 1000;
    this.processor = options.processor || (() => {});
    this.queue = [];
    this.timer = null;
  }

  add(item) {
    this.queue.push(item);

    if (this.queue.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.batchSize);
    await this.processor(batch);

    // Process remaining items
    if (this.queue.length > 0) {
      setImmediate(() => this.flush());
    }
  }

  async shutdown() {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    while (this.queue.length > 0) {
      await this.flush();
    }
  }
}
/**
 * Resource pool for reusing expensive objects
 */
export class ResourcePool {
  constructor(factory, options = {}) {
    this.factory = factory;
    this.maxSize = options.maxSize || 10;
    this.available = [];
    this.inUse = new Set();
  }

  async acquire() {
    // Return available resource
    if (this.available.length > 0) {
      const resource = this.available.pop();
      this.inUse.add(resource);
      return resource;
    }

    // Create new resource if under limit
    if (this.inUse.size < this.maxSize) {
      const resource = await this.factory();
      this.inUse.add(resource);
      return resource;
    }

    // Wait for resource to become available
    return new Promise(resolve => {
      const checkAvailable = () => {
        if (this.available.length > 0) {
          const resource = this.available.pop();
          this.inUse.add(resource);
          resolve(resource);
        } else {
          setTimeout(checkAvailable, 10);
        }
      };
      checkAvailable();
    });
  }

  release(resource) {
    if (this.inUse.has(resource)) {
      this.inUse.delete(resource);
      this.available.push(resource);
    }
  }

  async drain() {
    // Wait for all resources to be released
    while (this.inUse.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Clean up available resources
    this.available = [];
  }
}
/**
 * Debounce function for reducing frequent calls
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
/**
 * Throttle function for limiting call frequency
 */
export function throttle(func, limit) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}
/**
 * Memory usage monitor
 */
export class MemoryMonitor {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.8; // 80% of heap
    this.checkInterval = options.checkInterval || 5000;
    this.onThreshold = options.onThreshold || (() => {});
    this.monitoring = false;
  }

  start() {
    if (this.monitoring) return;

    this.monitoring = true;
    this.interval = setInterval(() => {
      const usage = process.memoryUsage();
      const heapUsed = usage.heapUsed;
      const heapTotal = usage.heapTotal;
      const ratio = heapUsed / heapTotal;

      if (ratio > this.threshold) {
        this.onThreshold({
          heapUsed,
          heapTotal,
          ratio,
          rss: usage.rss
        });
      }
    }, this.checkInterval);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.monitoring = false;
    }
  }

  static getMemoryStats() {
    const usage = process.memoryUsage();
    return {
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(usage.rss / 1024 / 1024) + ' MB',
      external: Math.round(usage.external / 1024 / 1024) + ' MB'
    };
  }
}
