import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@assistant/contracts': fileURLToPath(
        new URL('packages/contracts/src/index.ts', import.meta.url),
      ),
      '@assistant/core': fileURLToPath(
        new URL('packages/core/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
    ],
    clearMocks: true,
    restoreMocks: true,
  },
});
