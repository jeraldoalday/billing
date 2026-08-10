import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests share a single SQLite file; run test files sequentially
    // to avoid cross-file races on beforeEach() resets.
    fileParallelism: false,
  },
});
