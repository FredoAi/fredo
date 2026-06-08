import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/shared/test-utils/vitest-setup.ts'],
  },
});
