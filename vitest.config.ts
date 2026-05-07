import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest configuration.
 *
 * Most tests run in Node (engine, scan, manifest, paths, store). The
 * renderer tests under `tests/renderer/**` need a DOM, so they run in
 * jsdom via `environmentMatchGlobs` (Phase 7 decision — chosen over
 * per-file `// @vitest-environment jsdom` directives so the convention
 * is centralised and discoverable).
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: false,
    // Default 5s is tight on Windows CI runners — Defender can briefly
    // hold file handles, making temp-dir cleanup in afterEach exceed
    // the per-hook budget. Bump generously; individual tests still see
    // their own timeouts.
    testTimeout: 15_000,
    hookTimeout: 15_000
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  }
});
