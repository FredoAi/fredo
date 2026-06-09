import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    setupFiles: ['./src/shared/test-utils/vitest-setup.ts'],
    // Run tests one fork at a time to avoid parallel heap exhaustion from
    // jsdom + Chakra v3 @layer CSS parse errors in component tests.
    // A single fork processes files sequentially; with 20GB heap (from
    // execArgv), it can handle all 21 test files without OOM.
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 1,
        execArgv: ['--max-old-space-size=20480'],
      },
    },
    // Increase test timeout for component rendering
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
