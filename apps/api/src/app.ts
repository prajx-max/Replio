import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  IdSchema,
  ModelReplySchema,
  ProfileSyncSchema,
  ProviderConfigurationSchema,
  SuggestionRequestSchema,
  SuggestionResponseSchema,
} from '@assistant/contracts';
import {
  buildReplyPrompt,
  validateGroundedReply,
  permitsDraftNow,
} from '@assistant/core';
import { ConfigurationStore, sameSecret } from './services/configuration.js';
import { HttpLlmProvider, ServiceFailure } from './providers/llm/provider.js';
import type { LlmProvider } from './providers/llm/provider.js';

export interface BackendOptions {
  port?: number;
  provider?: LlmProvider;
  connectionFile?: string;
}
const errorStatus = (code: string) =>
  code === 'UNAUTHORIZED'
    ? 403
    : code === 'RATE_LIMITED'
      ? 429
      : code === 'INVALID_REQUEST'
        ? 400
        : 502;
async function body(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length'] ?? 0) > 131072)
    throw new ServiceFailure('INVALID_REQUEST');
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new ServiceFailure('INVALID_REQUEST');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 131072) throw new ServiceFailure('INVALID_REQUEST');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ServiceFailure('INVALID_REQUEST');
  }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(value));
}

export function createBackend(options: BackendOptions = {}) {
  const store = new ConfigurationStore(options.connectionFile);
  const provider = options.provider ?? new HttpLlmProvider();
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const rates = new Map<string, { count: number; expires: number }>();
  let origin = '';
  function limited(key: string, maximum: number) {
    const now = Date.now();
    for (const [id, rate] of rates) if (rate.expires < now) rates.delete(id);
    const rate = rates.get(key) ?? { count: 0, expires: now + 60000 };
    rate.count++;
    rates.set(key, rate);
    if (rate.count > maximum) throw new ServiceFailure('RATE_LIMITED');
  }
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    void (async () => {
      if (request.headers.host !== new URL(origin).host)
        throw new ServiceFailure('UNAUTHORIZED');
      const requestOrigin = request.headers.origin;
      const extensionOrigin = Boolean(
        requestOrigin && /^chrome-extension:\/\/[a-p]{32}$/.test(requestOrigin),
      );
      if (requestOrigin && requestOrigin !== origin && !extensionOrigin)
        throw new ServiceFailure('UNAUTHORIZED');
      if (extensionOrigin && requestOrigin) {
        response.setHeader('Access-Control-Allow-Origin', requestOrigin);
        response.setHeader('Vary', 'Origin');
        response.setHeader(
          'Access-Control-Allow-Headers',
          'content-type,x-assistant-token',
        );
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      limited('local', 180);
      const url = new URL(request.url ?? '/', origin);
      const cookie = request.headers.cookie?.match(
        /(?:^|;\s*)assistant_setup=([a-zA-Z0-9_-]+)/,
      )?.[1];
      const session = cookie ? sessions.get(cookie) : undefined;
      const setupAuthorized = Boolean(
        session &&
        session.expires > Date.now() &&
        requestOrigin === origin &&
        sameSecret(String(request.headers['x-csrf-token'] ?? ''), session.csrf),
      );
      if (
        request.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/setup')
      ) {
        for (const [key, saved] of sessions)
          if (saved.expires < Date.now()) sessions.delete(key);
        if (sessions.size > 100) throw new ServiceFailure('RATE_LIMITED');
        const key = randomBytes(32).toString('base64url');
        sessions.set(key, {
          csrf: randomBytes(32).toString('base64url'),
          expires: Date.now() + 3600000,
        });
        response.setHeader(
          'Set-Cookie',
          `assistant_setup=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
        );
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          await readFile(new URL('../public/setup.html', import.meta.url)),
        );
        return;
      }
      if (
        request.method === 'GET' &&
        ['/setup.js', '/setup.css'].includes(url.pathname)
      ) {
        response.setHeader(
          'Content-Type',
          url.pathname.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : 'text/css; charset=utf-8',
        );
        response.end(
          await readFile(new URL(`../public${url.pathname}`, import.meta.url)),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { status: 'ok', version: '0.6.0' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/setup/state') {
        if (
          !session ||
          session.expires < Date.now() ||
          (requestOrigin && requestOrigin !== origin) ||
          request.headers['sec-fetch-site'] === 'cross-site'
        )
          throw new ServiceFailure('UNAUTHORIZED');
        const profileId = IdSchema.parse(url.searchParams.get('profileId'));
        json(response, 200, {
          ...store.describe(profileId),
          csrf: session.csrf,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/setup/')) {
        if (!setupAuthorized) throw new ServiceFailure('UNAUTHORIZED');
        limited('configuration', 20);
        if (url.pathname === '/setup/configure') {
          const configured = store.configure(
            ProviderConfigurationSchema.parse(await body(request)),
          );
          json(response, 200, configured);
          return;
        }
        const input = z
          .strictObject({ profileId: IdSchema })
          .parse(await body(request));
        if (url.pathname === '/setup/clear') {
          store.clear(input.profileId);
          json(response, 200, { ok: true });
          return;
        }
        if (url.pathname === '/setup/test') {
          const description = store.describe(input.profileId);
          const config = store.authorize(description.pairingCode);
          if (!config) throw new ServiceFailure('NOT_CONFIGURED');
          const output = await provider.generate({
            ...store.generation(config),
            system:
              'Return JSON only: {"reply":"Ready","needsHuman":true,"evidenceIds":[]}. This is a user-requested connection test.',
            input: 'Check connection.',
          });
          ModelReplySchema.parse(output);
          json(response, 200, { ok: true });
          return;
        }
      }
      const config = store.authorize(
        String(request.headers['x-assistant-token'] ?? ''),
      );
      if (!config) throw new ServiceFailure('UNAUTHORIZED');
      if (request.method === 'GET' && url.pathname === '/api/status') {
        const {
          configured,
          provider: name,
          model,
        } = store.describe(config.profileId);
        json(response, 200, { configured, provider: name, model });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/profiles') {
        const { profile } = ProfileSyncSchema.parse(await body(request));
        if (profile.id !== config.profileId)
          throw new ServiceFailure('UNAUTHORIZED');
        if (JSON.stringify(profile).includes(store.generation(config).apiKey))
          throw new ServiceFailure('INVALID_REQUEST');
        store.profiles.set(profile.id, profile);
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/assist') {
        limited(`assist:${config.profileId}`, 20);
        const input = SuggestionRequestSchema.parse(await body(request));
        if (input.profileId !== config.profileId)
          throw new ServiceFailure('UNAUTHORIZED');
        const profile = store.profiles.get(input.profileId);
        if (!profile || profile.replyMode !== 'DRAFT_ONLY')
          throw new ServiceFailure('PROFILE_MISSING');
        if (!permitsDraftNow(profile))
          throw new ServiceFailure('PROFILE_MISSING');
        const prompt = buildReplyPrompt(profile, input.text);
        const credentials = store.generation(config);
        const output = await provider.generate({
          ...credentials,
          ...prompt,
        });
        const containsKey =
          typeof output === 'object' &&
          output !== null &&
          'reply' in output &&
          typeof output.reply === 'string' &&
          output.reply.includes(credentials.apiKey);
        const validated = validateGroundedReply(
          containsKey ? null : output,
          profile,
          input.text,
        );
        json(
          response,
          200,
          SuggestionResponseSchema.parse({
            requestId: input.requestId,
            ...validated,
            provider: config.provider,
            model: config.model,
          }),
        );
        return;
      }
      json(response, 404, { error: 'INVALID_REQUEST' });
    })().catch((failure: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const code =
        failure instanceof ServiceFailure
          ? failure.code
          : failure instanceof z.ZodError
            ? 'INVALID_REQUEST'
            : 'PROVIDER_UNAVAILABLE';
      json(response, errorStatus(code), { error: code });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    store,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 3000, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No backend port');
      origin = `http://127.0.0.1:${address.port}`;
      return origin;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      sessions.clear();
    },
  };
}
