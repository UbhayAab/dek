// Web bundle for the native shells, built from apps/web without touching it.
//
// Identical to the web build (same sources, same Vite, automatic JSX runtime as
// @vitejs/plugin-react uses in production), plus one thing: until
// apps/web/src/main.tsx calls initNative() itself, this build prepends that call
// at bundle time. Once main.tsx has it, the plugin does nothing.
// Used by scripts/android-build.mjs; output goes to apps/mobile/dist-native.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..', 'web');
const outDir = join(here, '..', 'dist-native');

function nativeEntry() {
  return {
    name: 'dek-native-entry',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/main.tsx')) return null;
      if (/from ['"]\.\/native['"]/.test(code)) return null;
      return { code: `import { initNative } from './native';\ninitNative();\n${code}`, map: null };
    },
  };
}

export default {
  root: webRoot,
  configFile: false,
  plugins: [nativeEntry()],
  esbuild: { jsx: 'automatic' },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 600,
  },
};
