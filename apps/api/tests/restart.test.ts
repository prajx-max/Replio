import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/app.js';
import type { GenerationInput } from '../src/providers/llm/provider.js';
import { bakeryProfile } from '../../../packages/test-fixtures/src/profiles.js';

const active = new Set<ReturnType<typeof createBackend>>();
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all([...active].map((app) => app.close()));
  active.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function connectionFile() {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-restart-'));
  temporaryDirectories.push(directory);
  return join(directory, '.env.connections');
}

async function start(file: string) {
  const inputs: GenerationInput[] = [];
  const app = createBackend({
    port: 0,
    connectionFile: file,
    provider: {
      async generate(input) {
        inputs.push(input);
        return {
          reply: 'Chocolate Truffle Cake is ₹650 for 500 grams.',
          needsHuman: false,
          evidenceIds: ['business-information'],
        };
      },
    },
  });
  active.add(app);
  const origin = await app.listen();
  const session = await fetch(`${origin}/setup`);
  const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
  const state = async (profileId = 'sweet-crumbs-demo') => {
    const response = await fetch(
      `${origin}/setup/state?profileId=${encodeURIComponent(profileId)}`,
      { headers: { cookie } },
    );
    return (await response.json()) as {
      csrf: string;
      configured: boolean;
      remembered: boolean;
      persistenceAvailable: boolean;
      model: string;
      pairingCode: string;
    };
  };
  const csrf = (await state()).csrf;
  const setup = (path: string, input: unknown) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        cookie,
        Origin: origin,
        'x-csrf-token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  const api = (token: string, path: string, input?: unknown) =>
    fetch(`${origin}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        'x-assistant-token': token,
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  return {
    app,
    state,
    setup,
    api,
    inputs,
    async stop() {
      await app.close();
      active.delete(app);
    },
  };
}

const configuration = {
  profileId: 'sweet-crumbs-demo',
  provider: 'openai',
  model: 'restart-fixture-model',
  apiKey: 'restart-fixture-key-not-real',
  remember: true,
};
const savedConnection = {
  profileId: configuration.profileId,
  provider: configuration.provider,
  model: configuration.model,
  apiKey: configuration.apiKey,
  token: 'a'.repeat(43),
};
function encodedEnvironment(input: unknown) {
  return `ASSISTANT_SAVED_CONNECTIONS_V1=${Buffer.from(JSON.stringify(input)).toString('base64url')}\n`;
}

describe('remembered local backend connection', () => {
  it.each(['groq', 'custom'])(
    'restores %s endpoint and output options with the same pairing after restart',
    async (provider) => {
      const file = await connectionFile();
      const before = await start(file);
      const options = {
        provider,
        model: 'vendor/preferred-model',
        responseFormat: 'text',
        ...(provider === 'custom'
          ? { baseUrl: 'https://models.vendor.com/api/v1' }
          : {}),
      };
      expect(
        (
          await before.setup('/setup/configure', {
            ...configuration,
            ...options,
          })
        ).status,
      ).toBe(200);
      const token = (await before.state()).pairingCode;
      await before.stop();
      const after = await start(file);
      expect(await after.state()).toMatchObject({
        ...options,
        configured: true,
        remembered: true,
        pairingCode: token,
      });
      expect(
        (
          await after.setup('/setup/test', {
            profileId: configuration.profileId,
          })
        ).status,
      ).toBe(200);
      expect(after.inputs[0]).toMatchObject({
        ...options,
        apiKey: configuration.apiKey,
      });
      expect((await after.api(token, '/api/status')).status).toBe(200);
    },
  );
  it('keeps pairing and provider credentials through restart without persisting customer data', async () => {
    const file = await connectionFile();
    const before = await start(file);
    expect((await before.state()).persistenceAvailable).toBe(true);
    const configured = await before.setup('/setup/configure', configuration);
    expect(configured.status).toBe(200);
    const saved = await before.state();
    expect(saved).toMatchObject({ configured: true, remembered: true });
    const token = saved.pairingCode;
    await before.api(token, '/api/profiles', { profile: bakeryProfile() });
    const customerMessage = 'Restart privacy sentinel: cake price please?';
    expect(
      (
        await before.api(token, '/api/assist', {
          profileId: configuration.profileId,
          chatKey: 'b'.repeat(64),
          requestId: 'before-restart',
          text: customerMessage,
        })
      ).status,
    ).toBe(200);
    await before.stop();

    const after = await start(file);
    expect(await after.state()).toMatchObject({
      configured: true,
      remembered: true,
      model: configuration.model,
      pairingCode: token,
    });
    expect((await after.api(token, '/api/status')).status).toBe(200);
    expect(
      (
        await after.api(token, '/api/profiles', {
          profile: { ...bakeryProfile(), id: 'another-business' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await after.api(token, '/api/profiles', { profile: bakeryProfile() }))
        .status,
    ).toBe(200);
    const generated = await after.api(token, '/api/assist', {
      profileId: configuration.profileId,
      chatKey: 'c'.repeat(64),
      requestId: 'after-restart',
      text: 'What is the cake price?',
    });
    expect(generated.status).toBe(200);
    expect(after.inputs[0]).toMatchObject({
      apiKey: configuration.apiKey,
      provider: configuration.provider,
      model: configuration.model,
    });
    expect(await generated.text()).not.toContain(configuration.apiKey);
    const persisted = await readFile(file, 'utf8');
    const decoded = Buffer.from(
      parseEnv(persisted).ASSISTANT_SAVED_CONNECTIONS_V1 ?? '',
      'base64url',
    ).toString('utf8');
    expect(decoded).toContain(configuration.apiKey);
    expect(decoded).not.toContain(customerMessage);
    expect(decoded).not.toContain(bakeryProfile().replyInstructions);
    expect(decoded).not.toContain(bakeryProfile().businessInformation);
  });

  it('preserves remembered model changes without re-entering the same provider key', async () => {
    const file = await connectionFile();
    const before = await start(file);
    await before.setup('/setup/configure', configuration);
    const token = (await before.state()).pairingCode;
    expect(
      (
        await before.setup('/setup/configure', {
          profileId: configuration.profileId,
          provider: configuration.provider,
          model: 'changed-restart-model',
          remember: true,
        })
      ).status,
    ).toBe(200);
    await before.stop();
    const after = await start(file);
    expect(await after.state()).toMatchObject({
      configured: true,
      pairingCode: token,
      model: 'changed-restart-model',
      remembered: true,
    });
  });

  it('does not restore a session-only connection after restart', async () => {
    const file = await connectionFile();
    const before = await start(file);
    expect(
      (
        await before.setup('/setup/configure', {
          ...configuration,
          remember: false,
        })
      ).status,
    ).toBe(200);
    const token = (await before.state()).pairingCode;
    await before.stop();
    const after = await start(file);
    expect(await after.state()).toMatchObject({
      configured: false,
      remembered: false,
    });
    expect((await after.api(token, '/api/status')).status).toBe(403);
  });

  it('removes a previously remembered connection when switching to session-only', async () => {
    const file = await connectionFile();
    const before = await start(file);
    await before.setup('/setup/configure', configuration);
    const token = (await before.state()).pairingCode;
    expect(
      (
        await before.setup('/setup/configure', {
          profileId: configuration.profileId,
          provider: configuration.provider,
          model: configuration.model,
          remember: false,
        })
      ).status,
    ).toBe(200);
    expect((await before.api(token, '/api/status')).status).toBe(200);
    await before.stop();
    const after = await start(file);
    expect((await after.state()).configured).toBe(false);
    expect((await after.api(token, '/api/status')).status).toBe(403);
  });

  it('keeps explicit removal revoked after restart and preserves other profiles', async () => {
    const file = await connectionFile();
    const before = await start(file);
    await before.setup('/setup/configure', configuration);
    const removedToken = (await before.state()).pairingCode;
    const otherId = 'another-business';
    await before.setup('/setup/configure', {
      ...configuration,
      profileId: otherId,
      apiKey: 'second-restart-fixture-key',
    });
    const otherToken = (await before.state(otherId)).pairingCode;
    expect(
      (
        await before.setup('/setup/clear', {
          profileId: configuration.profileId,
        })
      ).status,
    ).toBe(200);
    expect((await before.api(removedToken, '/api/status')).status).toBe(403);
    await before.stop();
    const after = await start(file);
    expect((await after.api(removedToken, '/api/status')).status).toBe(403);
    expect((await after.api(otherToken, '/api/status')).status).toBe(200);
    expect((await after.state()).configured).toBe(false);
    expect(await after.state(otherId)).toMatchObject({
      configured: true,
      remembered: true,
      pairingCode: otherToken,
    });
  });

  it('fails startup on invalid saved configuration without exposing its contents', async () => {
    const file = await connectionFile();
    const sentinel = 'private-corrupt-file-sentinel';
    await writeFile(file, sentinel, 'utf8');
    let failure: unknown;
    try {
      createBackend({ port: 0, connectionFile: file });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(sentinel);
  });

  it('reports a failed save without changing the active connection or exposing credentials', async () => {
    const file = await connectionFile();
    const backend = await start(file);
    expect(
      (await backend.setup('/setup/configure', configuration)).status,
    ).toBe(200);
    const original = await backend.state();
    await rm(file);
    await mkdir(file);
    const failure = await backend.setup('/setup/configure', {
      ...configuration,
      model: 'must-not-be-committed',
      apiKey: 'new-key-must-not-be-committed',
    });
    expect(failure.status).toBe(502);
    expect(await failure.json()).toEqual({
      error: 'CONFIGURATION_SAVE_FAILED',
    });
    expect(await backend.state()).toMatchObject({
      configured: true,
      model: configuration.model,
      pairingCode: original.pairingCode,
    });
    expect(
      (await backend.api(original.pairingCode, '/api/status')).status,
    ).toBe(200);
    await backend.api(original.pairingCode, '/api/profiles', {
      profile: bakeryProfile(),
    });
    await backend.api(original.pairingCode, '/api/assist', {
      profileId: configuration.profileId,
      chatKey: 'd'.repeat(64),
      requestId: 'after-failed-save',
      text: 'What is the cake price?',
    });
    expect(backend.inputs[0]?.apiKey).toBe(configuration.apiKey);
  });

  it.each([
    [
      'duplicate tokens',
      [savedConnection, { ...savedConnection, profileId: 'another-business' }],
    ],
    [
      'duplicate profile identities',
      [savedConnection, { ...savedConnection, token: 'b'.repeat(43) }],
    ],
    [
      'unexpected configuration fields',
      [{ ...savedConnection, execute: 'no' }],
    ],
  ])('rejects %s in persisted data', async (_label, entries) => {
    const file = await connectionFile();
    await writeFile(file, encodedEnvironment(entries), 'utf8');
    expect(() => createBackend({ port: 0, connectionFile: file })).toThrow(
      'Saved backend connection could not be loaded.',
    );
  });

  it('rejects an oversized saved file before loading connection credentials', async () => {
    const file = await connectionFile();
    await writeFile(file, 'x'.repeat(65537), 'utf8');
    expect(() => createBackend({ port: 0, connectionFile: file })).toThrow(
      'Saved backend connection could not be loaded.',
    );
  });

  it('fails a new save at capacity without evicting another business or changing the file', async () => {
    const file = await connectionFile();
    const entries = Array.from({ length: 32 }, (_, index) => ({
      ...savedConnection,
      profileId: `business-${index}`,
      token: Buffer.alloc(32, index + 1).toString('base64url'),
    }));
    const contents = encodedEnvironment(entries);
    await writeFile(file, contents, 'utf8');
    const backend = await start(file);
    const failed = await backend.setup('/setup/configure', configuration);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: 'CONFIGURATION_SAVE_FAILED',
    });
    expect((await backend.state()).configured).toBe(false);
    for (const entry of entries) {
      expect((await backend.state(entry.profileId)).configured).toBe(true);
      expect((await backend.api(entry.token, '/api/status')).status).toBe(200);
    }
    expect(await readFile(file, 'utf8')).toBe(contents);
  });
});
