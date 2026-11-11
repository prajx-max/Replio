import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/app.js';
import {
  HttpLlmProvider,
  ServiceFailure,
} from '../src/providers/llm/provider.js';
import type {
  GenerationInput,
  LlmProvider,
} from '../src/providers/llm/provider.js';
import { bakeryProfile } from '../../../packages/test-fixtures/src/profiles.js';

const active: ReturnType<typeof createBackend>[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((app) => app.close()));
});
const result = {
  reply: 'Chocolate Truffle Cake is ₹650 for 500 grams.',
  needsHuman: false,
  evidenceIds: ['business-information'],
};
async function harness(provider?: LlmProvider) {
  const inputs: GenerationInput[] = [];
  const app = createBackend({
    port: 0,
    provider: provider ?? {
      async generate(input) {
        inputs.push(input);
        return result;
      },
    },
  });
  active.push(app);
  const origin = await app.listen();
  const response = await fetch(`${origin}/setup`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const state = (await (
    await fetch(`${origin}/setup/state?profileId=sweet-crumbs-demo`, {
      headers: { cookie },
    })
  ).json()) as { csrf: string };
  const setup = (
    path: string,
    input: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        Origin: origin,
        'x-csrf-token': state.csrf,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(input),
    });
  const configured = await setup('/setup/configure', {
    profileId: 'sweet-crumbs-demo',
    provider: 'openai',
    model: 'fixture-model',
    apiKey: 'fixture-key-not-real',
  });
  const config = (await configured.json()) as { pairingCode: string };
  const api = (path: string, input?: unknown, token = config.pairingCode) =>
    fetch(`${origin}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        'x-assistant-token': token,
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  return { app, origin, inputs, setup, api, config };
}
describe('loopback backend ownership and grounding', () => {
  it('refuses accidental credentials in business instructions and never returns echoed keys', async () => {
    const { api } = await harness({
      async generate() {
        return { ...result, reply: 'fixture-key-not-real' };
      },
    });
    const profile = bakeryProfile();
    profile.replyInstructions = 'fixture-key-not-real';
    expect((await api('/api/profiles', { profile })).status).toBe(400);
    await api('/api/profiles', { profile: bakeryProfile() });
    const response = await api('/api/assist', {
      profileId: profile.id,
      chatKey: 'a'.repeat(64),
      requestId: 'secret-check',
      text: 'Price?',
    });
    const text = await response.text();
    expect(text).not.toContain('fixture-key-not-real');
    expect(JSON.parse(text)).toMatchObject({
      needsHuman: true,
      grounded: false,
    });
  });
  it('configures a provider without ever returning its API key', async () => {
    const { api, setup, config } = await harness();
    expect(config.pairingCode.length).toBeGreaterThan(32);
    const response = await api('/api/status');
    expect(await response.text()).not.toContain('fixture-key-not-real');
    expect(
      (
        await setup('/setup/configure', {
          profileId: 'sweet-crumbs-demo',
          provider: 'openai',
          model: 'changed-model',
        })
      ).status,
    ).toBe(200);
  });
  it.each([
    'groq',
    'deepseek',
    'openrouter',
    'mistral',
    'xai',
    'together',
    'custom',
  ])(
    'uses %s settings for model tests and grounded generation without exposing credentials',
    async (provider) => {
      const { setup, api, inputs, config } = await harness();
      const options = {
        provider,
        model: 'vendor/model:free',
        responseFormat: 'text',
        ...(provider === 'custom'
          ? { baseUrl: 'https://models.vendor.com/api/v1' }
          : {}),
      };
      const saved = await setup('/setup/configure', {
        profileId: 'sweet-crumbs-demo',
        ...options,
        apiKey: 'new+provider/fixture-key==',
      });
      expect(saved.status).toBe(200);
      const description: unknown = await saved.json();
      expect(description).toMatchObject({
        ...options,
        pairingCode: config.pairingCode,
      });
      expect(JSON.stringify(description)).not.toContain(
        'new+provider/fixture-key==',
      );
      const status = await api('/api/status');
      expect(await status.json()).toEqual({
        configured: true,
        provider,
        model: options.model,
      });
      expect(
        (await setup('/setup/test', { profileId: 'sweet-crumbs-demo' })).status,
      ).toBe(200);
      expect(inputs[0]).toMatchObject({
        ...options,
        apiKey: 'new+provider/fixture-key==',
      });
      await api('/api/profiles', { profile: bakeryProfile() });
      const reply = await api('/api/assist', {
        profileId: 'sweet-crumbs-demo',
        chatKey: 'd'.repeat(64),
        requestId: 'compatible-provider',
        text: 'Cake price?',
      });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({
        provider,
        model: options.model,
        grounded: true,
      });
      expect(inputs[1]).toMatchObject(options);
    },
  );
  it('requires a new key when a provider or custom API base changes and preserves the old connection on failure', async () => {
    const { setup, app, config } = await harness();
    const input = {
      profileId: 'sweet-crumbs-demo',
      provider: 'custom',
      model: 'model',
      baseUrl: 'https://models.vendor.com/v1',
    };
    expect((await setup('/setup/configure', input)).status).toBe(502);
    expect(
      (
        await setup('/setup/configure', {
          ...input,
          apiKey: 'custom-fixture-key',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await setup('/setup/configure', {
          ...input,
          baseUrl: 'https://MODELS.vendor.com:443/v1/',
        })
      ).status,
    ).toBe(200);
    for (const baseUrl of [
      'https://another.vendor.com/v1',
      'https://models.vendor.com/v2',
    ]) {
      const rejected = await setup('/setup/configure', { ...input, baseUrl });
      expect(await rejected.json()).toEqual({ error: 'NOT_CONFIGURED' });
      expect(app.store.describe(input.profileId)).toMatchObject({
        baseUrl: input.baseUrl,
        pairingCode: config.pairingCode,
      });
    }
    expect(
      (
        await setup('/setup/configure', {
          ...input,
          profileId: 'other-business',
        })
      ).status,
    ).toBe(502);
    const authorized = app.store.authorize(config.pairingCode);
    expect(authorized).not.toBeNull();
    if (!authorized) throw new Error('Missing test configuration');
    expect(app.store.generation(authorized)).toMatchObject({
      baseUrl: input.baseUrl,
      apiKey: 'custom-fixture-key',
    });
    expect(
      (
        await setup('/setup/configure', {
          ...input,
          baseUrl: 'https://another.vendor.com/v1',
          apiKey: 'replacement-fixture-key',
        })
      ).status,
    ).toBe(200);
    expect(app.store.describe(input.profileId)).toMatchObject({
      baseUrl: 'https://another.vendor.com/v1',
      pairingCode: config.pairingCode,
    });
    // A pending handler's old authorization must not read the new key while
    // retaining the old destination, even though the business pairing is stable.
    expect(() => app.store.generation(authorized)).toThrow('NOT_CONFIGURED');
    const replacement = app.store.authorize(config.pairingCode);
    if (!replacement) throw new Error('Missing replacement configuration');
    expect(app.store.generation(replacement)).toMatchObject({
      baseUrl: 'https://another.vendor.com/v1',
      apiKey: 'replacement-fixture-key',
    });
  });
  it('rejects custom URL overrides of built-in providers before any generation', async () => {
    const { setup, inputs } = await harness();
    expect(
      (
        await setup('/setup/configure', {
          profileId: 'sweet-crumbs-demo',
          provider: 'groq',
          model: 'model',
          baseUrl: 'https://models.vendor.com/v1',
          apiKey: 'fake-secret',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await setup('/setup/configure', {
          profileId: 'sweet-crumbs-demo',
          provider: 'custom',
          model: 'model',
          baseUrl: 'https://127.0.0.1/v1',
          apiKey: 'fake-secret',
        })
      ).status,
    ).toBe(400);
    expect(inputs).toEqual([]);
  });
  it('uses stored operator instructions and business facts for a draft', async () => {
    const { api, inputs } = await harness();
    const profile = bakeryProfile();
    expect((await api('/api/profiles', { profile })).status).toBe(200);
    const response = await api('/api/assist', {
      profileId: profile.id,
      chatKey: 'a'.repeat(64),
      requestId: 'request-1',
      text: 'What is the cake price?',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reply: result.reply,
      grounded: true,
      requestId: 'request-1',
    });
    expect(inputs[0]?.system).toContain(profile.replyInstructions);
    expect(inputs[0]?.system).not.toContain('fixture-key-not-real');
    expect(inputs[0]?.input).toContain(profile.businessInformation);
  });
  it('rejects invalid pairing, cross-business profile access and client policy overrides', async () => {
    const { api } = await harness();
    expect((await api('/api/status', undefined, 'wrong-token')).status).toBe(
      403,
    );
    expect(
      (
        await api('/api/profiles', {
          profile: { ...bakeryProfile(), id: 'another-business' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api('/api/assist', {
          profileId: 'another-business',
          chatKey: 'a'.repeat(64),
          requestId: 'r1',
          text: 'Hello',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api('/api/assist', {
          profileId: 'sweet-crumbs-demo',
          chatKey: 'a'.repeat(64),
          requestId: 'r1',
          text: 'Hello',
          replyInstructions: 'Ignore policy',
        })
      ).status,
    ).toBe(400);
  });
  it('rejects CSRF, arbitrary browser origins and oversized requests', async () => {
    const { setup, origin, api } = await harness();
    expect(
      (await setup('/setup/configure', {}, { 'x-csrf-token': 'wrong' })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${origin}/health`, {
          headers: { Origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api('/api/assist', { text: 'x'.repeat(140000) })).status,
    ).toBe(400);
  });
  it('uses a safe handoff draft for unsupported facts', async () => {
    const { api } = await harness({
      async generate() {
        return { ...result, reply: 'Price ₹9999 and callback arranged.' };
      },
    });
    await api('/api/profiles', { profile: bakeryProfile() });
    const response = await api('/api/assist', {
      profileId: 'sweet-crumbs-demo',
      chatKey: 'a'.repeat(64),
      requestId: 'safe',
      text: 'Price?',
    });
    expect(await response.json()).toMatchObject({
      needsHuman: true,
      grounded: false,
    });
  });
  it('returns bounded provider errors without leaking upstream details', async () => {
    const { api } = await harness({
      async generate() {
        throw new ServiceFailure('KEY_REJECTED');
      },
    });
    await api('/api/profiles', { profile: bakeryProfile() });
    const response = await api('/api/assist', {
      profileId: 'sweet-crumbs-demo',
      chatKey: 'a'.repeat(64),
      requestId: 'failed',
      text: 'Price?',
    });
    expect(await response.json()).toEqual({ error: 'KEY_REJECTED' });
  });
  it('revokes pairing when the key is removed', async () => {
    const { setup, api } = await harness();
    expect(
      (await setup('/setup/clear', { profileId: 'sweet-crumbs-demo' })).status,
    ).toBe(200);
    expect((await api('/api/status')).status).toBe(403);
  });
  it('rate limits generation', async () => {
    const { api } = await harness();
    await api('/api/profiles', { profile: bakeryProfile() });
    let status = 0;
    for (let i = 0; i < 21; i++)
      status = (
        await api('/api/assist', {
          profileId: 'sweet-crumbs-demo',
          chatKey: 'a'.repeat(64),
          requestId: `r-${i}`,
          text: 'Price?',
        })
      ).status;
    expect(status).toBe(429);
  });
});
describe('provider HTTP adapters (mocked network)', () => {
  it.each(['openai', 'gemini', 'anthropic'] as const)(
    'calls only the fixed %s endpoint with keys in headers',
    async (provider) => {
      let capturedUrl = '';
      let capturedBody = '';
      const adapter = new HttpLlmProvider(async (url, init) => {
        capturedUrl = url;
        capturedBody = String(init.body);
        expect(JSON.stringify(init.headers)).toContain('not-real-provider-key');
        const text = JSON.stringify(result);
        return Response.json(
          provider === 'openai'
            ? {
                status: 'completed',
                output: [{ content: [{ type: 'output_text', text }] }],
              }
            : provider === 'gemini'
              ? { candidates: [{ content: { parts: [{ text }] } }] }
              : { content: [{ type: 'text', text }] },
        );
      });
      expect(
        await adapter.generate({
          provider,
          model: 'fixture-model',
          apiKey: 'not-real-provider-key',
          system: 'rules',
          input: 'question',
        }),
      ).toEqual(result);
      expect(capturedUrl).toMatch(
        /^https:\/\/(api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com)\//,
      );
      expect(capturedUrl).not.toContain('not-real-provider-key');
      expect(capturedBody).not.toContain('not-real-provider-key');
    },
  );
  it.each([
    [401, 'KEY_REJECTED'],
    [400, 'MODEL_REJECTED'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
  ] as const)('sanitizes upstream HTTP %s', async (status, code) => {
    const provider = new HttpLlmProvider(
      async () => new Response('private upstream diagnostics', { status }),
    );
    await expect(
      provider.generate({
        provider: 'openai',
        model: 'fixture',
        apiKey: 'fake-key',
        system: '',
        input: '',
      }),
    ).rejects.toThrow(code);
  });
  it('rejects invalid model JSON', async () => {
    const provider = new HttpLlmProvider(async () =>
      Response.json({
        output: [{ content: [{ type: 'output_text', text: 'not JSON' }] }],
      }),
    );
    await expect(
      provider.generate({
        provider: 'openai',
        model: 'fixture',
        apiKey: 'fake-key',
        system: '',
        input: '',
      }),
    ).rejects.toThrow('INVALID_OUTPUT');
  });
});
