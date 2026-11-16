import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

// Per-environment Vite port (#2944). Unset/invalid falls back to the legacy
// 5174 default so single-env behaviour is byte-identical. `strictPort` below
// keeps a collision fail-closed — the port is never silently reallocated.
const parsedEnvPort = Number.parseInt(process.env.FREDO_VITE_PORT ?? '', 10);
const port = Number.isInteger(parsedEnvPort) && parsedEnvPort > 0 ? parsedEnvPort : 5174;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve @fredo/ui directly from source for fast HMR
      '@fredo/ui': resolve(__dirname, '../ui/src/index.ts'),
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port,
    host: host ?? 'localhost',
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      // Watch for changes in @fredo/ui source
      ignored: ['!**/apps/ui/src/**'],
    },
  },
  build: {
    // Tauri expects the frontend dist at this path
    outDir: 'dist',
    emptyOutDir: true,
    // Produce sourcemaps for debugging
    sourcemap: !!process.env.TAURI_DEBUG,
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
  },
});
