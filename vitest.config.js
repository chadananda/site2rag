import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 60000,  // integration tests invoke real tools (tesseract, pdftoppm) — need >5s
    coverage: { provider: 'v8', reporter: ['text', 'json'] }
  }
});
