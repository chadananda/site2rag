// Tests for spell-fix.js: buildEntries, prompt construction, spellFixMarkdown, spellFixCost.
// Anthropic SDK is mocked — no real API calls.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Single shared mock so all Anthropic instances share the same spy
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMock },
  })),
}));

import { spellFixWordObjects, spellFixMarkdown, spellFixCost } from '../../src/pdf-upgrade/spell-fix.js';

function okResponse(text = '', tokIn = 10, tokOut = 5) {
  return { content: [{ text }], usage: { input_tokens: tokIn, output_tokens: tokOut } };
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue(okResponse());
});

describe('spellFixCost', () => {
  it('returns a positive number for typical inputs', () => {
    expect(spellFixCost(10, 2000)).toBeGreaterThan(0);
  });

  it('scales linearly with page count', () => {
    expect(spellFixCost(10, 2000)).toBeCloseTo(spellFixCost(1, 2000) * 10, 10);
  });
});

describe('spellFixWordObjects — prompt construction', () => {
  it('includes document title in system prompt', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', { title: 'Ottoman History' });
    expect(createMock.mock.calls[0][0].system).toContain('Ottoman History');
  });

  it('includes language in system prompt', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', { language: 'turkish' });
    expect(createMock.mock.calls[0][0].system).toContain('turkish');
  });

  it('includes domainContext in system prompt', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', {
      domainContext: 'Expert OCR correction for Sufi manuscripts.',
    });
    expect(createMock.mock.calls[0][0].system).toContain('Expert OCR correction for Sufi manuscripts.');
  });

  it('includes Vision A and Vision B labels when both drafts provided', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', {
      visionDraft: { boss: 'Boss says: world history', marker: 'Marker says: world' },
    });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).toContain('Vision A:');
    expect(sys).toContain('Boss says: world history');
    expect(sys).toContain('Vision B:');
    expect(sys).toContain('Marker says: world');
  });

  it('truncates vision drafts to 800 chars', async () => {
    const longText = 'x'.repeat(1200);
    await spellFixWordObjects([{ text: 'wrold' }], 'key', {
      visionDraft: { boss: longText, marker: null },
    });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).toContain('Vision A:');
    // Full 1200-char string should not appear (truncated at 800)
    expect(sys).not.toContain(longText);
  });

  it('omits vision section when both boss and marker are null', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', {
      visionDraft: { boss: null, marker: null },
    });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).not.toContain('Vision A:');
    expect(sys).not.toContain('Vision B:');
  });

  it('includes only Vision A when marker is null', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', {
      visionDraft: { boss: 'Boss text', marker: null },
    });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).toContain('Vision A:');
    expect(sys).not.toContain('Vision B:');
  });

  it('includes prevPageTail in system prompt', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', {
      prevPageTail: 'the chapter ends here with important context',
    });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).toContain('Previous page ends with');
    expect(sys).toContain('the chapter ends here');
  });

  it('includes pageNo and totalPages when both provided', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', { pageNo: 3, totalPages: 12 });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).toContain('Page: 3 of 12');
  });

  it('includes only pageNo when totalPages not provided', async () => {
    await spellFixWordObjects([{ text: 'wrold' }], 'key', { pageNo: 5 });
    const sys = createMock.mock.calls[0][0].system;
    expect(sys).toContain('Page: 5');
    expect(sys).not.toContain('Page: 5 of');
  });

  it('sends numbered word list in user message', async () => {
    await spellFixWordObjects([{ text: 'hello' }, { text: 'wrold' }], 'key', {});
    const userContent = createMock.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('1:hello');
    expect(userContent).toContain('2:wrold');
  });

  it('applies correction from N:word response', async () => {
    createMock.mockResolvedValueOnce(okResponse('2:world\n'));
    const result = await spellFixWordObjects([{ text: 'hello' }, { text: 'wrold' }], 'key', {});
    expect(result.words[0].text).toBe('hello');
    expect(result.words[1].text).toBe('world');
  });

  it('merges hyphen-broken pair into single corrected word', async () => {
    createMock.mockResolvedValueOnce(okResponse('1:anticipates\n'));
    const result = await spellFixWordObjects([{ text: 'antici-' }, { text: 'pates' }], 'key', {});
    expect(result.words).toHaveLength(1);
    expect(result.words[0].text).toBe('anticipates');
  });

  it('uncorrected hyphen pair concatenates with hyphen when model skips it', async () => {
    // Model returns no correction for the merged entry → ¶ stripped, hyphen remains
    createMock.mockResolvedValueOnce(okResponse(''));
    const result = await spellFixWordObjects([{ text: 'antici-' }, { text: 'pates' }], 'key', {});
    expect(result.words).toHaveLength(1);
    expect(result.words[0].text).toBe('antici-pates');
  });

  it('returns cost_usd, tokens_in, tokens_out', async () => {
    createMock.mockResolvedValueOnce(okResponse('', 20, 8));
    const result = await spellFixWordObjects([{ text: 'hello' }], 'key', {});
    expect(result.tokens_in).toBe(20);
    expect(result.tokens_out).toBe(8);
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('leaves uncorrected words with original text', async () => {
    createMock.mockResolvedValueOnce(okResponse(''));
    const result = await spellFixWordObjects([{ text: 'hello' }], 'key', {});
    expect(result.words[0].text).toBe('hello');
  });
});

describe('spellFixWordObjects — hyphen merge edge cases', () => {
  it('does NOT merge hyphen when next word starts uppercase', async () => {
    createMock.mockResolvedValueOnce(okResponse(''));
    // "Co-" + "Op" → Co- starts with -, next is uppercase → no merge → 2 entries
    const result = await spellFixWordObjects([{ text: 'Co-' }, { text: 'Op' }], 'key', {});
    expect(result.words).toHaveLength(2);
    expect(result.words[0].text).toBe('Co-');
    expect(result.words[1].text).toBe('Op');
  });

  it('does NOT merge hyphen on last word (no next)', async () => {
    createMock.mockResolvedValueOnce(okResponse(''));
    const result = await spellFixWordObjects([{ text: 'trailing-' }], 'key', {});
    expect(result.words).toHaveLength(1);
    expect(result.words[0].text).toBe('trailing-');
  });

  it('does NOT merge when word does not end with hyphen', async () => {
    createMock.mockResolvedValueOnce(okResponse(''));
    const result = await spellFixWordObjects([{ text: 'hello' }, { text: 'world' }], 'key', {});
    expect(result.words).toHaveLength(2);
  });

  it('adds _srcIdx to all result words', async () => {
    createMock.mockResolvedValueOnce(okResponse(''));
    const result = await spellFixWordObjects([{ text: 'hello' }, { text: 'world' }], 'key', {});
    expect(result.words[0]._srcIdx).toBe(0);
    expect(result.words[1]._srcIdx).toBe(1);
  });

  it('adds _mergedSrcIdx to result word when hyphen pair merged', async () => {
    createMock.mockResolvedValueOnce(okResponse('1:anticipates\n'));
    const result = await spellFixWordObjects([{ text: 'antici-' }, { text: 'pates' }], 'key', {});
    expect(result.words[0]._srcIdx).toBe(0);
    expect(result.words[0]._mergedSrcIdx).toBe(1);
  });

  it('extends bbox when hyphen pair is on the same line', async () => {
    // Same line: next.y1 <= obj.y2
    createMock.mockResolvedValueOnce(okResponse('1:anticipates\n'));
    const words = [
      { text: 'antici-', x1: 10, y1: 100, x2: 80, y2: 120 },
      { text: 'pates',   x1: 90, y1: 100, x2: 150, y2: 120 },
    ];
    const result = await spellFixWordObjects(words, 'key', {});
    expect(result.words[0].x2).toBe(150); // extended to cover second word
    expect(result.words[0].y2).toBe(120);
  });

  it('does NOT extend bbox for cross-line hyphen (second word below first)', async () => {
    // Cross-line: next.y1 (200) > obj.y2 (120)
    createMock.mockResolvedValueOnce(okResponse('1:continuation\n'));
    const words = [
      { text: 'con-',        x1: 10, y1: 100, x2: 80, y2: 120 },
      { text: 'tinuation',   x1: 10, y1: 200, x2: 150, y2: 220 }, // next line
    ];
    const result = await spellFixWordObjects(words, 'key', {});
    expect(result.words[0].x2).toBe(80); // NOT extended — bbox stays at first word
    expect(result.words[0].y2).toBe(120);
  });
});

describe('spellFixMarkdown', () => {
  it('returns corrected markdown joined by spaces', async () => {
    createMock.mockResolvedValueOnce(okResponse('2:world\n'));
    const result = await spellFixMarkdown('hello wrold', 'key', {});
    expect(result.markdown).toBe('hello world');
  });

  it('returns cost_usd', async () => {
    const result = await spellFixMarkdown('hello', 'key', {});
    expect(typeof result.cost_usd).toBe('number');
  });

  it('preserves uncorrected words in output', async () => {
    createMock.mockResolvedValueOnce(okResponse(''));
    const result = await spellFixMarkdown('the quick brown fox', 'key', {});
    expect(result.markdown).toBe('the quick brown fox');
  });
});
