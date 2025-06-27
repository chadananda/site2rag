// performanceOptimizer.test.js
import {describe, it, expect, vi} from 'vitest';
import {
  BoundedArray,
  BoundedSet,
  LRUCache,
  BatchProcessor,
  debounce,
  throttle,
  MemoryMonitor
} from '../../../src/utils/performanceOptimizer.js';
describe('performanceOptimizer', () => {
  describe('BoundedArray', () => {
    it('should limit array size', () => {
      const arr = new BoundedArray(3);
      arr.push(1);
      arr.push(2);
      arr.push(3);
      arr.push(4);

      expect(arr.length).toBe(3);
      expect(arr.toArray()).toEqual([2, 3, 4]);
    });

    it('should handle clear operation', () => {
      const arr = new BoundedArray(5);
      arr.push(1);
      arr.push(2);
      arr.clear();

      expect(arr.length).toBe(0);
      expect(arr.toArray()).toEqual([]);
    });
  });

  describe('BoundedSet', () => {
    it('should limit set size with LRU eviction', () => {
      const set = new BoundedSet(3);
      set.add('a');
      set.add('b');
      set.add('c');
      set.add('d');

      expect(set.size).toBe(3);
      expect(set.has('a')).toBe(false); // 'a' was evicted
      expect(set.has('d')).toBe(true);
    });

    it('should not add duplicates', () => {
      const set = new BoundedSet(5);
      set.add('a');
      set.add('a');
      set.add('a');

      expect(set.size).toBe(1);
    });

    it('should convert to array', () => {
      const set = new BoundedSet(3);
      set.add('x');
      set.add('y');

      const arr = set.toArray();
      expect(arr).toHaveLength(2);
      expect(arr).toContain('x');
      expect(arr).toContain('y');
    });
  });

  describe('LRUCache', () => {
    it('should evict least recently used items', () => {
      const cache = new LRUCache(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Access 'a' to make it recently used
      cache.get('a');

      // Add new item, 'b' should be evicted
      cache.set('d', 4);

      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should update position on set for existing key', () => {
      const cache = new LRUCache(2);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 3); // Update 'a'
      cache.set('c', 4); // Should evict 'b', not 'a'

      expect(cache.get('a')).toBe(3);
      expect(cache.has('b')).toBe(false);
      expect(cache.get('c')).toBe(4);
    });
  });

  describe('BatchProcessor', () => {
    it('should process items in batches', async () => {
      const processed = [];
      const processor = new BatchProcessor({
        batchSize: 3,
        processor: async batch => {
          processed.push(...batch);
        }
      });

      processor.add(1);
      processor.add(2);
      processor.add(3); // Should trigger batch

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(processed).toEqual([1, 2, 3]);
    });

    it('should flush on shutdown', async () => {
      const processed = [];
      const processor = new BatchProcessor({
        batchSize: 5,
        flushInterval: 10000, // Long interval
        processor: async batch => {
          processed.push(...batch);
        }
      });

      processor.add(1);
      processor.add(2);

      await processor.shutdown();
      expect(processed).toEqual([1, 2]);
    });
  });

  describe('debounce', () => {
    it('should debounce function calls', async () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 50);

      debounced(1);
      debounced(2);
      debounced(3);

      expect(fn).not.toHaveBeenCalled();

      await new Promise(resolve => setTimeout(resolve, 60));
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(3);
    });
  });

  describe('throttle', () => {
    it('should throttle function calls', async () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 50);

      throttled(1);
      throttled(2); // Should be ignored
      throttled(3); // Should be ignored

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(1);

      await new Promise(resolve => setTimeout(resolve, 60));
      throttled(4);
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith(4);
    });
  });

  describe('MemoryMonitor', () => {
    it('should provide memory stats', () => {
      const stats = MemoryMonitor.getMemoryStats();

      expect(stats).toHaveProperty('heapUsed');
      expect(stats).toHaveProperty('heapTotal');
      expect(stats).toHaveProperty('rss');
      expect(stats).toHaveProperty('external');

      // Check format
      expect(stats.heapUsed).toMatch(/^\d+ MB$/);
    });

    it('should monitor memory and trigger callback', async () => {
      const callback = vi.fn();
      const monitor = new MemoryMonitor({
        threshold: 0.01, // Very low threshold to ensure trigger
        checkInterval: 10,
        onThreshold: callback
      });

      monitor.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      monitor.stop();

      expect(callback).toHaveBeenCalled();
      const call = callback.mock.calls[0][0];
      expect(call).toHaveProperty('heapUsed');
      expect(call).toHaveProperty('ratio');
    });
  });
});
