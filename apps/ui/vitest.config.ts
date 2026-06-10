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
    environment: 'jsdom',
    setupFiles: ['./src/shared/test-utils/vitest-setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=8192'],
      },
    },
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
