import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  build: {
    outDir: mode === 'fixture' ? 'dist-fixture' : 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: false,
    lib: {
      entry: fileURLToPath(
        new URL('src/content/whatsapp/index.ts', import.meta.url),
      ),
      name: 'UniversalWhatsAppAdapter',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
  },
}));
