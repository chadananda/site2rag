import { execSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { describe, it, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../bin/site2rag.js');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (e) {
    return e.stdout || e.stderr || e.message;
  }
}

describe('site2rag CLI', () => {
  it('shows help with no args', () => {
    const out = run(`node ${CLI_PATH}`);
    expect(out).toContain('Usage: site2rag');
    expect(out).toContain('A CLI tool for crawling sites');
  });

  it('shows help with --help', () => {
    const out = run(`node ${CLI_PATH} --help`);
    expect(out).toContain('Usage: site2rag');
    expect(out.includes('Commands:') || out.includes('Options:')).toBe(true);
  });

  it('shows version with --version', () => {
    const out = run(`node ${CLI_PATH} --version`);
    expect(out.trim()).toBe('0.1.0');
  });

  it('accepts a url and prints crawl message', () => {
    const out = run(`node ${CLI_PATH} docs.example.com`);
    expect(out).toContain('Crawling: docs.example.com');
    expect(out).toMatch(/Output dir: \.(\/|\\)docs\.example\.com/);
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
    const out = run(`node ${CLI_PATH} docs.example.com --update`);
    expect(out).toContain('Updating crawl for docs.example.com');
  });

  it('accepts --dry-run', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --dry-run`);
    expect(out).toContain('[Dry Run] Would crawl: docs.example.com');
  });

  it('accepts --max-depth', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --max-depth 2`);
    expect(out).toContain('Max depth: 2');
  });

  it('accepts --limit', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --limit 5`);
    expect(out).toContain('Limit: 5 pages');
  });

  it('defaults output to ./<domain>', () => {
    const out = run(`node ${CLI_PATH} docs.example.com`);
    expect(out).toMatch(/Output dir: \.(\/|\\)docs\.example\.com/);
  });

  it('uses --output if provided', () => {
    const out = run(`node ${CLI_PATH} docs.example.com --output ./foo`);
    expect(out).toContain('Output dir: ./foo');
  });
});
