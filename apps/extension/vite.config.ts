import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { manifest } from './manifest.config.js';

const path = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    {
      name: 'mv3-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: JSON.stringify(
            mode === 'fixture'
              ? {
                  ...manifest,
                  name: `${manifest.name} [TEST FIXTURE]`,
                  host_permissions: [
                    'https://web.whatsapp.com/*',
                    'http://127.0.0.1:4174/*',
                    'http://127.0.0.1:4175/*',
                  ],
                  content_scripts: [
                    {
                      ...manifest.content_scripts[0],
                      matches: [
                        'https://web.whatsapp.com/*',
                        'http://127.0.0.1:4174/*',
                      ],
                    },
                  ],
                  content_security_policy: {
                    extension_pages:
                      manifest.content_security_policy.extension_pages.replace(
                        'http://127.0.0.1:3000',
                        'http://127.0.0.1:4175',
                      ),
                  },
                }
              : manifest,
            null,
            2,
          ),
        });
      },
    },
  ],
  build: {
    outDir: mode === 'fixture' ? 'dist-fixture' : 'dist',
    target: 'chrome116',
    sourcemap: false,
    rolldownOptions: {
      input: {
        popup: path('popup.html'),
        sidepanel: path('sidepanel.html'),
        options: path('options.html'),
        'service-worker': path('src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
}));
