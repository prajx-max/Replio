import { createBackend } from './app.js';
import { ProviderSchema, ResponseFormatSchema } from '@assistant/contracts';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('API_PORT must be between 1024 and 65535');
const connectionFile = fileURLToPath(
  new URL('../../../.env.connections', import.meta.url),
);
const previouslySaved = existsSync(connectionFile);
const app = createBackend({ port, connectionFile });
if (process.env.LLM_API_KEY && !previouslySaved) {
  try {
    app.store.configure({
      profileId: process.env.ASSISTANT_PROFILE_ID ?? 'sweet-crumbs-demo',
      provider: ProviderSchema.parse(process.env.LLM_PROVIDER ?? 'openai'),
      model: process.env.LLM_MODEL ?? '',
      apiKey: process.env.LLM_API_KEY,
      ...(process.env.LLM_BASE_URL
        ? { baseUrl: process.env.LLM_BASE_URL }
        : {}),
      ...(process.env.LLM_RESPONSE_FORMAT
        ? {
            responseFormat: ResponseFormatSchema.parse(
              process.env.LLM_RESPONSE_FORMAT,
            ),
          }
        : {}),
      remember: true,
    });
  } catch {
    throw new Error(
      'Invalid backend provider environment configuration. Check LLM_PROVIDER, LLM_MODEL, LLM_API_KEY and any custom endpoint/format settings.',
    );
  }
}
const origin = await app.listen();
console.log(`Local AI setup: ${origin}/setup`);
console.log(
  'Use setup to remember this connection on this PC, or choose session-only storage.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
