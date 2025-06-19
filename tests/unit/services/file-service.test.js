import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileService } from '../../../src/services/file_service.js';
import fs from 'fs';
import path from 'path';

// Mock fs and path modules
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    default: {
      ...actual.default,
      promises: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn(),
        access: vi.fn()
      },
      constants: { F_OK: 0 }
    },
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn(),
      access: vi.fn()
    },
    constants: { F_OK: 0 }
  };
});

// Mock path module
vi.mock('path');

// Setup path mock implementation
const mockJoin = vi.fn((...args) => args.join('/'));
const mockDirname = vi.fn((p) => p.split('/').slice(0, -1).join('/') || '.');

// Set the mock implementations
path.join = mockJoin;
path.dirname = mockDirname;

describe('FileService', () => {
  let fileService;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Setup mock implementations for fs.promises.readFile
    fs.promises.readFile.mockImplementation((path) => {
      if (path === '/path/to/existing-file.txt') {
        return Promise.resolve('file content');
      } else if (path === '/path/to/valid.json') {
        return Promise.resolve(JSON.stringify({ key: 'value' }));
      } else if (path === '/path/to/invalid.json') {
        return Promise.resolve('not json');
      }
      return Promise.reject(new Error('ENOENT: no such file or directory'));
    });
    
    // Setup mock implementations for fs.promises.access
    fs.promises.access.mockImplementation((path) => {
      if (path === './existing-dir' || path === '/path/to/existing-file.txt' || path === '/path/to/valid.json') {
        return Promise.resolve();
      }
      return Promise.reject(new Error('ENOENT: no such file or directory'));
    });
    
    // Create service instance with test output directory
    fileService = new FileService({
      outputDir: './test-output'
    });
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });
  
  describe('constructor', () => {
    it('should initialize with default output directory', () => {
      const defaultService = new FileService();
      expect(defaultService.outputDir).toBe('./output');
    });
    
    it('should initialize with provided output directory', () => {
      expect(fileService.outputDir).toBe('./test-output');
    });
  });
  
  describe('ensureDir', () => {
    it('should not create directory if it exists', async () => {
      await fileService.ensureDir('./existing-dir');
      
      expect(fs.promises.access).toHaveBeenCalledWith('./existing-dir');
      expect(fs.promises.mkdir).not.toHaveBeenCalled();
    });
    
    it('should create directory if it does not exist', async () => {
      // Mock access to throw error (directory doesn't exist)
      fs.promises.access.mockRejectedValueOnce(new Error('ENOENT'));
      
      await fileService.ensureDir('./new-dir');
      
      expect(fs.promises.access).toHaveBeenCalledWith('./new-dir');
      expect(fs.promises.mkdir).toHaveBeenCalledWith('./new-dir', { recursive: true });
    });
  });
  
  describe('writeFile', () => {
    it('should ensure directory exists before writing file', async () => {
      const ensureDirSpy = vi.spyOn(fileService, 'ensureDir');
      
      await fileService.writeFile('./dir/file.txt', 'content');
      
      expect(ensureDirSpy).toHaveBeenCalledWith('./dir');
      expect(fs.promises.writeFile).toHaveBeenCalledWith('./dir/file.txt', 'content', 'utf8');
    });
  });
  
  describe('readFile', () => {
    it('should read file content', async () => {
      fs.promises.readFile.mockResolvedValueOnce('file content');
      
      const content = await fileService.readFile('./test.txt');
      
      expect(fs.promises.readFile).toHaveBeenCalledWith('./test.txt', 'utf8');
      expect(content).toBe('file content');
    });
    
    it('should return default value if file does not exist', async () => {
      fs.promises.readFile.mockRejectedValueOnce(new Error('ENOENT'));
      
      const content = await fileService.readFile('./missing.txt', 'default');
      
      expect(fs.promises.readFile).toHaveBeenCalledWith('./missing.txt', 'utf8');
      expect(content).toBe('default');
    });
  });
  
  describe('fileExists', () => {
    it('should return true if file exists', async () => {
      // Mock for this specific test
      fs.promises.access.mockResolvedValueOnce();
      
      const exists = await fileService.fileExists('./existing.txt');
      
      expect(fs.promises.access).toHaveBeenCalledWith('./existing.txt', fs.constants.F_OK);
      expect(exists).toBe(true);
    });
    
    it('should return false if file does not exist', async () => {
      fs.promises.access.mockRejectedValueOnce(new Error('ENOENT'));
      
      const exists = await fileService.fileExists('./missing.txt');
      
      expect(fs.promises.access).toHaveBeenCalledWith('./missing.txt', fs.constants.F_OK);
      expect(exists).toBe(false);
    });
  });
  
  describe('getOutputPath', () => {
    it('should combine output directory, domain, and filename', () => {
      // Reset the mock join function
      mockJoin.mockClear();
      
      const outputPath = fileService.getOutputPath('example.com', 'page.md');
      
      expect(mockJoin).toHaveBeenCalledWith('./test-output', 'example.com');
      expect(mockJoin).toHaveBeenCalledWith('./test-output/example.com', 'page.md');
      expect(outputPath).toBe('./test-output/example.com/page.md');
    });
  });
  
  describe('saveMarkdown', () => {
    it('should save markdown to the correct path', async () => {
      const writeFileSpy = vi.spyOn(fileService, 'writeFile').mockResolvedValue();
      
      // Reset the mock join function
      mockJoin.mockClear();
      
      await fileService.saveMarkdown('example.com', 'page.md', '# Content');
      
      expect(mockJoin).toHaveBeenCalledWith('./test-output', 'example.com');
      expect(mockJoin).toHaveBeenCalledWith('./test-output/example.com', 'page.md');
      expect(writeFileSpy).toHaveBeenCalledWith('./test-output/example.com/page.md', '# Content');
    });
  });
  
  describe('readJson', () => {
    it('should read and parse JSON file', async () => {
      fs.promises.readFile.mockResolvedValueOnce('{"key":"value"}');
      
      const data = await fileService.readJson('./data.json');
      
      expect(fs.promises.readFile).toHaveBeenCalledWith('./data.json', 'utf8');
      expect(data).toEqual({ key: 'value' });
    });
    
    it('should return default value for missing or invalid JSON', async () => {
      fs.promises.readFile.mockRejectedValueOnce(new Error('ENOENT'));
      
      const data = await fileService.readJson('./missing.json', { default: true });
      
      expect(fs.promises.readFile).toHaveBeenCalledWith('./missing.json', 'utf8');
      expect(data).toEqual({ default: true });
    });
  });
  
  describe('writeJson', () => {
    it('should stringify and write JSON data', async () => {
      const writeFileSpy = vi.spyOn(fileService, 'writeFile').mockResolvedValueOnce();
      
      await fileService.writeJson('./data.json', { key: 'value' });
      
      expect(writeFileSpy).toHaveBeenCalledWith('./data.json', JSON.stringify({ key: 'value' }, null, 2));
    });
  });
});
