import { defineConfig } from 'vite';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  publicDir: '../public',
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  optimizeDeps: {
    exclude: ['@mudomi/onykia-engine', '@mudomi/onykia-codemirror'],
  },
});
