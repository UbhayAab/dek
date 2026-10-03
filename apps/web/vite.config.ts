import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Hashed file names for everything but index.html and sw.js: the service worker
// precaches exactly the files this build emitted (scripts/build-sw.mjs), and
// Cloudflare serves hashed assets as immutable (public/_headers).
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 600,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    restoreMocks: true,
  },
});
