// ai_request_tracker.test.js
// Tests for the shared AI request tracker
import {describe, it, expect, beforeEach} from 'vitest';
import {AIRequestTracker} from '../../../src/core/ai_request_tracker.js';

describe('AIRequestTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new AIRequestTracker();
  });

  describe('initialization', () => {
    it('should calculate expected requests based on eligible blocks', () => {
      const documents = [
        {
          docId: 'doc1',
          blocks: [
            {
              text: 'This is a long paragraph with more than 100 characters to ensure it passes the minimum length requirement for processing.'
            },
            {text: '# Header - should be skipped'},
            {text: '```code block - should be skipped```'},
            {text: 'Short text'}, // Less than 100 chars - skipped
            {
              text: 'Another long paragraph with sufficient content to be considered eligible for AI processing and context enhancement.'
            }
          ]
        },
        {
          docId: 'doc2',
          blocks: [
            {
              text: 'This document has several eligible blocks that should be counted in the total expected requests for processing.'
            },
            {
              text: 'Second eligible block with enough content to pass the minimum character threshold for AI context processing.'
            },
            {
              text: 'Third eligible block that contains sufficient text to be included in the window calculation for requests.'
            }
          ]
        }
      ];

      let progressUpdates = [];
      const progressCallback = (current, total) => {
        progressUpdates.push({current, total});
      };

      tracker.initialize(documents, progressCallback);

      // Doc1: 2 eligible blocks → 1 window
      // Doc2: 3 eligible blocks → 1 window
      // Total: 2 windows expected
      expect(tracker.totalExpected).toBe(2);
      expect(progressUpdates).toHaveLength(1);
      expect(progressUpdates[0]).toEqual({current: 0, total: 2});
    });

    it('should handle empty documents', () => {
      const documents = [];
      tracker.initialize(documents, null);
      expect(tracker.totalExpected).toBe(0);
    });

    it('should handle documents with no eligible blocks', () => {
      const documents = [
        {
          docId: 'doc1',
          blocks: [{text: '# Header'}, {text: 'Short'}, {text: '```code```'}]
        }
      ];
      tracker.initialize(documents, null);
      expect(tracker.totalExpected).toBe(0);
    });
  });

  describe('updateDocumentActual', () => {
    it('should update total when actual differs from estimate', () => {
      const documents = [
        {
          docId: 'doc1',
          blocks: Array(10).fill({text: 'A'.repeat(150)}) // 10 blocks → estimate 2 windows
        },
        {
          docId: 'doc2',
          blocks: Array(15).fill({text: 'B'.repeat(150)}) // 15 blocks → estimate 3 windows
        }
      ];

      tracker.initialize(documents, null);
      expect(tracker.totalExpected).toBe(5); // 2 + 3

      // Update doc1 with actual count
      tracker.updateDocumentActual('doc1', 3); // Actually needed 3 windows
      expect(tracker.totalExpected).toBe(6); // 3 + 3

      // Update doc2 with actual count
      tracker.updateDocumentActual('doc2', 4); // Actually needed 4 windows
      expect(tracker.totalExpected).toBe(7); // 3 + 4
    });
  });

  describe('trackCompletion', () => {
    it('should increment completed count and notify progress', () => {
      const documents = [
        {
          docId: 'doc1',
          blocks: Array(5).fill({text: 'A'.repeat(150)})
        }
      ];

      let progressUpdates = [];
      const progressCallback = (current, total) => {
        progressUpdates.push({current, total});
      };

      tracker.initialize(documents, progressCallback);
      progressUpdates = []; // Clear initialization update

      tracker.trackCompletion();
      expect(tracker.totalCompleted).toBe(1);
      expect(progressUpdates).toHaveLength(1);
      expect(progressUpdates[0].current).toBe(1);

      tracker.trackCompletion();
      expect(tracker.totalCompleted).toBe(2);
      expect(progressUpdates).toHaveLength(2);
      expect(progressUpdates[1].current).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      const documents = [
        {docId: 'doc1', blocks: Array(5).fill({text: 'A'.repeat(150)})},
        {docId: 'doc2', blocks: Array(10).fill({text: 'B'.repeat(150)})}
      ];

      tracker.initialize(documents, null);
      tracker.updateDocumentActual('doc1', 2);
      tracker.trackCompletion();
      tracker.trackCompletion();

      const stats = tracker.getStats();
      expect(stats).toEqual({
        totalExpected: 4, // 2 (actual for doc1) + 2 (estimate for doc2)
        totalCompleted: 2,
        documentsProcessed: 1,
        documentsTotal: 2,
        percentComplete: 50
      });
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      const documents = [
        {
          docId: 'doc1',
          blocks: [{text: 'A'.repeat(150)}]
        }
      ];

      tracker.initialize(documents, () => {});
      tracker.trackCompletion();

      tracker.reset();

      expect(tracker.totalExpected).toBe(0);
      expect(tracker.totalCompleted).toBe(0);
      expect(tracker.documentEstimates.size).toBe(0);
      expect(tracker.documentActuals.size).toBe(0);
      expect(tracker.progressCallback).toBe(null);
      expect(tracker.isInitialized).toBe(false);
    });
  });

  describe('countEligibleBlocks', () => {
    it('should correctly filter blocks based on eligibility rules', () => {
      const blocks = [
        'This is a valid block with more than 100 characters that should be counted as eligible for processing.',
        '# Header block - should be skipped',
        '```code block``` - should be skipped',
        '    indented code - should be skipped',
        'Short', // Less than 100 chars
        '![image](url) - should be skipped',
        'Another valid block with sufficient length to be considered eligible for AI context enhancement processing.',
        '' // Empty block
      ];

      const count = tracker.countEligibleBlocks(blocks);
      expect(count).toBe(2); // Only 2 blocks are eligible
    });

    it('should handle blocks as objects', () => {
      const blocks = [
        {text: 'Valid block with more than 100 characters for eligibility testing in the AI request tracking system.'},
        {text: '# Header'},
        {text: 'Another valid block with enough content to be processed by the context enhancement system for testing.'}
      ];

      const count = tracker.countEligibleBlocks(blocks);
      expect(count).toBe(2);
    });

    it('should handle null or undefined blocks array', () => {
      expect(tracker.countEligibleBlocks(null)).toBe(0);
      expect(tracker.countEligibleBlocks(undefined)).toBe(0);
      expect(tracker.countEligibleBlocks([])).toBe(0);
    });
  });
});
