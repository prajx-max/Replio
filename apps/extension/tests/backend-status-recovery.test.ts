import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveController } from '../src/background/live-controller.js';
import { BackendClient } from '../src/background/backend-client.js';
import { createMessageRouter } from '../src/background/message-router.js';
import { SETTINGS_KEY } from '../src/storage/settings-repository.js';
import { createHarness, extensionId, trustedSender } from './helpers.js';

const healthy = () =>
  Response.json({
    configured: true,
    provider: 'gemini',
    model: 'fixture-model',
  });
const query = { type: 'GET_STATE', version: 1 } as const;

async function setup() {
  const h = createHarness();
  await h.repository.update((settings) => ({
    ...settings,
    connections: {
      [settings.activeProfileId]: {
        token: 'fixture-pairing',
        autoSuggest: true,
      },
    },
  }));
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => healthy());
  const backend = new BackendClient(request);
  const transport = {
    send: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
  };
  const controller = new LiveController(
    h.repository,
    h.local,
    transport,
    backend,
  );
  const route = createMessageRouter(
    h.repository,
    h.session,
    extensionId,
    controller,
  );
  return { ...h, request, backend, transport, controller, route };
}

afterEach(() => vi.restoreAllMocks());

describe('saved backend status after worker recreation', () => {
  it('rehydrates a trusted snapshot using only a bounded local status request without settings writes', async () => {
    const h = await setup();
    const before = structuredClone(h.local.values);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const response = await h.route(query, trustedSender);
    expect(response.ok && response.state.backend).toEqual({
      configured: true,
      provider: 'gemini',
      model: 'fixture-model',
      paired: true,
      error: '',
    });
    expect(h.request).toHaveBeenCalledTimes(1);
    const [url, options] = h.request.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:3000/api/status');
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
    });
    expect(options?.body).toBeUndefined();
    expect(timeout).toHaveBeenCalledExactlyOnceWith(2000);
    expect(h.local.values).toEqual(before);
    expect(h.transport.send).not.toHaveBeenCalled();
    await h.route(query, trustedSender);
    expect(h.request).toHaveBeenCalledTimes(1);

    const restarted = new LiveController(
      h.repository,
      h.local,
      h.transport,
      h.backend,
    );
    await restarted.rehydrateBackendStatus(await h.repository.load());
    expect(
      restarted.snapshot(await h.repository.load()).backend.configured,
    ).toBe(true);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.local.values).toEqual(before);
  });

  it('does not probe on adapter bootstrap, for an unpaired profile, or for an untrusted page', async () => {
    const h = await setup();
    await h.controller.bootstrap();
    expect(h.request).not.toHaveBeenCalled();
    expect(
      await h.route(query, {
        ...trustedSender,
        url: 'https://web.whatsapp.com/',
      }),
    ).toEqual({ ok: false, error: 'UNAUTHORIZED' });
    expect(h.request).not.toHaveBeenCalled();
    await h.repository.update((settings) => ({ ...settings, connections: {} }));
    const response = await h.route(query, trustedSender);
    expect(response.ok && response.state.backend.paired).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous status hydration for the same saved revision', async () => {
    const h = await setup();
    let finish: (response: Response) => void = () => undefined;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const settings = await h.repository.load();
    const first = h.controller.rehydrateBackendStatus(settings);
    const second = h.controller.rehydrateBackendStatus(settings);
    expect(h.request).toHaveBeenCalledTimes(1);
    finish(healthy());
    await Promise.all([first, second]);
    expect(h.controller.snapshot(settings).backend.configured).toBe(true);
  });

  it('rate limits transient retries without stopping recovery after a longer outage', async () => {
    const h = await setup();
    let now = 100000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h.request.mockRejectedValue(new Error('private socket failure'));
    const settings = await h.repository.load();
    await h.controller.rehydrateBackendStatus(settings);
    expect(h.controller.snapshot(settings).backend.error).toBe(
      'BACKEND_OFFLINE',
    );
    for (let attempt = 2; attempt <= 4; attempt++) {
      now += 14999;
      await h.controller.rehydrateBackendStatus(settings);
      expect(h.request).toHaveBeenCalledTimes(attempt - 1);
      now++;
      if (attempt === 4) h.request.mockImplementation(async () => healthy());
      await h.controller.rehydrateBackendStatus(settings);
      expect(h.request).toHaveBeenCalledTimes(attempt);
    }
    expect(h.controller.snapshot(settings).backend.configured).toBe(true);
    now += 60000;
    await h.controller.rehydrateBackendStatus(settings);
    expect(h.request).toHaveBeenCalledTimes(4);
  });

  it('keeps a sanitized rejected-pairing result instead of repeatedly probing it', async () => {
    const h = await setup();
    h.request.mockResolvedValue(
      Response.json(
        { error: 'UNAUTHORIZED', secret: 'private response detail' },
        { status: 401 },
      ),
    );
    const settings = await h.repository.load();
    await h.controller.rehydrateBackendStatus(settings);
    expect(h.controller.snapshot(settings).backend).toEqual({
      configured: false,
      provider: null,
      model: '',
      paired: true,
      error: 'UNAUTHORIZED',
    });
    expect(JSON.stringify(h.controller.snapshot(settings))).not.toContain(
      'private response detail',
    );
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
    await h.controller.rehydrateBackendStatus(settings);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it.each(['profile', 'token', 'revision', 'disconnect'] as const)(
    'discards a status that completes after %s ownership changes',
    async (change) => {
      const h = await setup();
      let finish: (response: Response) => void = () => undefined;
      h.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const settings = await h.repository.load();
      const pending = h.controller.rehydrateBackendStatus(settings);
      if (change === 'profile') {
        await h.repository.update((current) => ({
          ...current,
          activeProfileId: 'other-business',
          profiles: [
            ...current.profiles,
            { ...current.profiles[0]!, id: 'other-business' },
          ],
          connections: {
            ...current.connections,
            'other-business': { token: 'other-pairing', autoSuggest: true },
          },
        }));
      } else if (change === 'token') {
        // The exact credential guard must stand even if an external stored update
        // preserved the revision rather than using SettingsRepository.update.
        h.local.values[SETTINGS_KEY] = {
          ...settings,
          connections: {
            [settings.activeProfileId]: {
              token: 'replacement-pairing',
              autoSuggest: true,
            },
          },
        };
      } else if (change === 'revision') {
        await h.repository.update((current) => ({
          ...current,
          enabled: false,
        }));
      } else {
        await h.controller.disconnect();
      }
      finish(healthy());
      await pending;
      expect(
        h.controller.snapshot(await h.repository.load()).backend.configured,
      ).toBe(false);
      expect(h.controller.snapshot(settings).backend.configured).toBe(false);
    },
  );

  it('does not replace a newer generation error with a late healthy status response', async () => {
    const h = await setup();
    let finish: (response: Response) => void = () => undefined;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.request.mockImplementation(async (url) => {
      if (String(url).endsWith('/api/status')) return healthy();
      if (String(url).endsWith('/api/profiles'))
        return Response.json({ ok: true });
      return Response.json({ error: 'KEY_REJECTED' }, { status: 400 });
    });
    const settings = await h.repository.load();
    const pending = h.controller.rehydrateBackendStatus(settings);
    const context = {
      profileId: settings.activeProfileId,
      contextId: 'fixture-context',
      chatKey: 'a'.repeat(64),
      chatLabel: 'Fixture',
    };
    await h.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: {
          ready: true,
          context,
          matches: {
            appShell: 0,
            chatHeader: 0,
            messageList: 0,
            incomingMessage: 0,
            outgoingMessage: -1,
            messageText: 0,
            composer: 0,
            sendButton: -1,
          },
        },
      },
      1,
    );
    await h.controller.handle(
      {
        type: 'ADAPTER_MESSAGE',
        version: 1,
        context,
        eventKey: 'b'.repeat(64),
        text: 'Fictional fixture question',
      },
      1,
    );
    await vi.waitFor(() =>
      expect(h.controller.snapshot(settings).backend.error).toBe(
        'KEY_REJECTED',
      ),
    );
    finish(healthy());
    await pending;
    const calls = h.request.mock.calls.length;
    await h.controller.rehydrateBackendStatus(settings);
    expect(h.request).toHaveBeenCalledTimes(calls);
    expect(h.controller.snapshot(settings).backend.error).toBe('KEY_REJECTED');
    expect(h.controller.snapshot(settings).live?.suggestion?.error).toBe(
      'KEY_REJECTED',
    );
    expect(h.transport.send).not.toHaveBeenCalled();
  });
});
