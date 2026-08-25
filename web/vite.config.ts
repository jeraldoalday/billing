import react from '@vitejs/plugin-react';
// vitest/config re-exports Vite's defineConfig with the `test` block typed,
// so the dev server and the test runner stay in one config file.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API's CORS allowlist (server/src/middleware/cors.ts) defaults to
    // this exact origin, so fail loudly rather than silently moving to
    // another port and getting blocked by the browser.
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});
