import { execSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../../bin/site2rag.js');

function run(cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      env: {
        ...process.env,
        SITE2RAG_DB_PATH: require('path').join(process.cwd(), 'tests', 'tmp', 'cli-test.sqlite'),
        SITE2RAG_CONFIG_PATH: require('path').join(process.cwd(), 'tests', 'tmp', 'crawl.json'),
      },
    });
  } catch (e) {
    return e.stdout || e.stderr || e.message;
  }
}

describe('site2rag CLI', () => {
  it('shows help with no args', () => {
    const out = run(`node ${CLI_PATH}`);
    expect(out).toContain('Usage: site2rag');
    expect(out).toContain('A CLI tool for crawling sites');
  }, 20000);

  it('shows help with --help', () => {
    // Increased timeout for slow CLI startup
    const out = run(`node ${CLI_PATH} --help`);
    expect(out).toContain('Usage: site2rag');
    expect(out.includes('Commands:') || out.includes('Options:')).toBe(true);
  }, 20000);

  it('shows version with --version', () => {
    const out = run(`node ${CLI_PATH} --version`);
    expect(out.trim()).toBe('0.1.0');
  });

  it('accepts a url and prints crawl message', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --output tests/tmp/sites/cli-test`);
    expect(out).toContain('Crawling: https://docs.example.com');
    expect(out).toContain('Output dir: tests/tmp/sites/cli-test');
  });

  it('accepts --status', () => {
    const out = run(`node ${CLI_PATH} --status`);
    expect(out).toContain('Showing crawl status');
  });

  it('accepts --clean', () => {
    const out = run(`node ${CLI_PATH} --clean`);
    expect(out).toContain('Cleaning crawl state');
  });

  it('accepts --update', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --output tests/tmp/sites/cli-update --update`);
    expect(out).toContain('Updating crawl for https://docs.example.com');
  });

  it('accepts --dry-run', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --output tests/tmp/sites/cli-dry --dry-run`);
    expect(out).toContain('[Dry Run] Would crawl: https://docs.example.com');
  });

  it('accepts --limit', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --output tests/tmp/sites/cli-limit --limit 5`);
    expect(out).toContain('Limit: 5 pages');
  });

  it('defaults output to ./<domain>', () => {
    const out = run(`node ${CLI_PATH} docs.example.com`);
    expect(out).toMatch(/Output dir: (\.\/)?docs\.example\.com/);
  }, 20000);
  it('uses --output if provided', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --output tests/tmp/sites/cli-custom`);
    expect(out).toContain('Output dir: tests/tmp/sites/cli-custom');
  }, 20000);
});
