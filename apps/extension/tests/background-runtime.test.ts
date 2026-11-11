import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundRuntime,
  BACKGROUND_TABS_KEY,
  type BackgroundApi,
} from '../src/background/background-runtime.js';
import { createHarness, extensionId, trustedSender } from './helpers.js';
import { createMessageRouter } from '../src/background/message-router.js';

async function setup() {
  const h = createHarness();
  await h.repository.update((settings) => ({
    ...settings,
    connections: {
      [settings.activeProfileId]: { token: 'fixture-token', autoSuggest: true },
    },
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      replyMode: 'AUTO_REPLY_WEB',
      webAutoSendOptIn: true,
      backgroundReplies: true,
      keepAwake: true,
    })),
  }));
  let tabs: Awaited<ReturnType<BackgroundApi['tabs']['query']>> = [
    { id: 7, url: 'https://web.whatsapp.com/', autoDiscardable: true },
  ];
  const api = {
    tabs: {
      query: vi.fn(async () => structuredClone(tabs)),
      get: vi.fn(async (id: number) => {
        const found = tabs.find((tab) => tab.id === id);
        if (!found) throw new Error('Closed tab');
        return structuredClone(found);
      }),
      update: vi.fn(
        async (id: number, update: { autoDiscardable: boolean }) => {
          const found = tabs.find((tab) => tab.id === id);
          if (!found) throw new Error('Closed tab');
          Object.assign(found, update);
          return structuredClone(found);
        },
      ),
    },
    permissions: { contains: vi.fn(async () => true) },
    power: { requestKeepAwake: vi.fn(), releaseKeepAwake: vi.fn() },
  };
  const runtime = new BackgroundRuntime(h.repository, h.session, api);
  return {
    ...h,
    runtime,
    api,
    setTabs(value: typeof tabs) {
      tabs = value;
    },
  };
}

describe('opted-in background tab and power lifecycle', () => {
  it('authorizes only the sole loaded WhatsApp tab and never changes focus or URL', async () => {
    const h = await setup();
    expect(await h.runtime.isBackground(7)).toBe(true);
    expect(await h.runtime.isBackground(8)).toBe(false);
    await h.runtime.reconcile();
    expect(h.api.tabs.update).toHaveBeenCalledExactlyOnceWith(7, {
      autoDiscardable: false,
    });
    expect(h.session.values[BACKGROUND_TABS_KEY]).toEqual([
      { tabId: 7, autoDiscardable: true },
    ]);
    expect(h.api.power.requestKeepAwake).toHaveBeenCalledExactlyOnceWith(
      'system',
    );
  });
  it.each([
    'multiple',
    'discarded',
    'frozen',
    'navigating',
    'foreign',
    'missing',
  ])(
    'blocks background automation and releases idle wake for %s tabs',
    async (kind) => {
      const h = await setup();
      await h.runtime.reconcile();
      h.api.power.requestKeepAwake.mockClear();
      if (kind === 'multiple')
        h.setTabs([
          { id: 7, url: 'https://web.whatsapp.com/', autoDiscardable: false },
          { id: 8, url: 'https://web.whatsapp.com/' },
        ]);
      if (kind === 'discarded')
        h.setTabs([
          { id: 7, url: 'https://web.whatsapp.com/', discarded: true },
        ]);
      if (kind === 'frozen')
        h.setTabs([{ id: 7, url: 'https://web.whatsapp.com/', frozen: true }]);
      if (kind === 'navigating')
        h.setTabs([
          {
            id: 7,
            url: 'https://web.whatsapp.com/',
            pendingUrl: 'https://example.com/',
          },
        ]);
      if (kind === 'foreign')
        h.setTabs([{ id: 7, url: 'https://web.whatsapp.com.example.com/' }]);
      if (kind === 'missing') h.setTabs([]);
      expect(await h.runtime.isBackground(7)).toBe(false);
      await h.runtime.reconcile();
      expect(h.api.power.requestKeepAwake).not.toHaveBeenCalled();
      expect(h.api.power.releaseKeepAwake).toHaveBeenCalled();
      expect(h.session.values[BACKGROUND_TABS_KEY]).toEqual([]);
    },
  );
  it.each(['disable', 'background', 'disconnect', 'mode'])(
    'restores the original discard preference and releases wake on %s',
    async (reason) => {
      const h = await setup();
      await h.runtime.reconcile();
      await h.repository.update((settings) => ({
        ...settings,
        ...(reason === 'disable' ? { enabled: false } : {}),
        ...(reason === 'disconnect' ? { connections: {} } : {}),
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          ...(reason === 'background' || reason === 'mode'
            ? { backgroundReplies: false, keepAwake: false }
            : {}),
          ...(reason === 'mode'
            ? {
                replyMode: 'DRAFT_ONLY' as const,
                webAutoSendOptIn: false,
                autoOpenUnread: false,
                includeExistingUnread: false,
              }
            : {}),
        })),
      }));
      await h.runtime.reconcile();
      expect(h.api.tabs.update).toHaveBeenLastCalledWith(7, {
        autoDiscardable: true,
      });
      expect(h.api.power.releaseKeepAwake).toHaveBeenCalled();
      expect(await h.runtime.isBackground(7)).toBe(false);
    },
  );
  it('restores a prior false preference across service-worker recreation', async () => {
    const h = await setup();
    h.setTabs([
      { id: 7, url: 'https://web.whatsapp.com/', autoDiscardable: false },
    ]);
    await h.runtime.reconcile();
    const replacement = new BackgroundRuntime(h.repository, h.session, h.api);
    await h.repository.update((settings) => ({ ...settings, enabled: false }));
    await replacement.reconcile();
    expect(h.api.tabs.update).toHaveBeenLastCalledWith(7, {
      autoDiscardable: false,
    });
    expect(h.session.values[BACKGROUND_TABS_KEY]).toEqual([]);
  });
  it('keeps the original true preference across service-worker recreation', async () => {
    const h = await setup();
    await h.runtime.reconcile();
    const replacement = new BackgroundRuntime(h.repository, h.session, h.api);
    await replacement.reconcile();
    expect(h.session.values[BACKGROUND_TABS_KEY]).toEqual([
      { tabId: 7, autoDiscardable: true },
    ]);
    await h.repository.update((settings) => ({ ...settings, enabled: false }));
    await replacement.reconcile();
    expect(h.api.tabs.update).toHaveBeenLastCalledWith(7, {
      autoDiscardable: true,
    });
  });
  it('retains failed restore metadata for a still-existing tab and retries', async () => {
    const h = await setup();
    await h.runtime.reconcile();
    await h.repository.update((settings) => ({ ...settings, enabled: false }));
    h.api.tabs.update.mockRejectedValueOnce(new Error('Temporary unavailable'));
    await h.runtime.reconcile();
    expect(h.session.values[BACKGROUND_TABS_KEY]).toEqual([
      { tabId: 7, autoDiscardable: true },
    ]);
    await h.runtime.reconcile();
    expect(h.session.values[BACKGROUND_TABS_KEY]).toEqual([]);
    expect(h.api.tabs.update).toHaveBeenLastCalledWith(7, {
      autoDiscardable: true,
    });
  });
  it('does not request power without permission or keep-awake choice', async () => {
    const h = await setup();
    h.api.permissions.contains.mockResolvedValue(false);
    await h.runtime.reconcile();
    expect(h.api.power.requestKeepAwake).not.toHaveBeenCalled();
    expect(h.api.power.releaseKeepAwake).toHaveBeenCalled();
    h.api.permissions.contains.mockResolvedValue(true);
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        keepAwake: false,
      })),
    }));
    await h.runtime.reconcile();
    expect(h.api.power.requestKeepAwake).not.toHaveBeenCalled();
    expect(await h.runtime.isBackground(7)).toBe(true);
  });
  it('rechecks revocation during the asynchronous permission lookup', async () => {
    const h = await setup();
    h.api.permissions.contains.mockImplementationOnce(async () => {
      await h.repository.update((settings) => ({
        ...settings,
        enabled: false,
      }));
      return true;
    });
    await h.runtime.reconcile();
    expect(h.api.power.requestKeepAwake).not.toHaveBeenCalled();
    expect(h.api.power.releaseKeepAwake).toHaveBeenCalled();
  });
  it('does not mutate tab policy if recording its prior value fails', async () => {
    const h = await setup();
    vi.spyOn(h.session, 'set').mockRejectedValue(
      new Error('Storage unavailable'),
    );
    await h.runtime.reconcile();
    expect(h.api.tabs.update).not.toHaveBeenCalled();
    expect(h.api.power.requestKeepAwake).not.toHaveBeenCalled();
    expect(h.api.power.releaseKeepAwake).toHaveBeenCalled();
  });
  it('rejects a stale background decision when settings change during the tab query', async () => {
    const h = await setup();
    h.api.tabs.query.mockImplementationOnce(async () => {
      await h.repository.update((settings) => ({
        ...settings,
        enabled: false,
      }));
      return [{ id: 7, url: 'https://web.whatsapp.com/' }];
    });
    expect(await h.runtime.isBackground(7)).toBe(false);
  });
  it('permits the synthetic origin only when the fixture build supplies it', async () => {
    const h = await setup();
    h.setTabs([{ id: 9, url: 'http://127.0.0.1:4174/' }]);
    expect(await h.runtime.isBackground(9)).toBe(false);
    const fixture = new BackgroundRuntime(
      h.repository,
      h.session,
      h.api,
      'http://127.0.0.1:4174',
    );
    expect(await fixture.isBackground(9)).toBe(true);
  });
});

describe('read-only background diagnostics', () => {
  it.each([
    ['ready', 'READY', 1],
    ['missing', 'NO_WHATSAPP_TAB', 0],
    ['foreign', 'NO_WHATSAPP_TAB', 0],
    ['multiple', 'MULTIPLE_WHATSAPP_TABS', 2],
    ['discarded', 'TAB_DISCARDED', 1],
    ['frozen', 'TAB_FROZEN', 1],
    ['navigating', 'TAB_NAVIGATING', 1],
  ] as const)(
    'explains %s without changing browser state or exposing identifiers',
    async (kind, state, tabCount) => {
      const h = await setup();
      const tab = {
        id: 7,
        url: 'https://web.whatsapp.com/private-fixture-path',
      };
      if (kind === 'missing') h.setTabs([]);
      if (kind === 'foreign')
        h.setTabs([{ id: 7, url: 'https://web.whatsapp.com.example.com/' }]);
      if (kind === 'multiple') h.setTabs([tab, { ...tab, id: 8 }]);
      if (kind === 'discarded') h.setTabs([{ ...tab, discarded: true }]);
      if (kind === 'frozen') h.setTabs([{ ...tab, frozen: true }]);
      if (kind === 'navigating')
        h.setTabs([{ ...tab, pendingUrl: 'https://example.com/private' }]);
      const writeLocal = vi.spyOn(h.local, 'set');
      const writeSession = vi.spyOn(h.session, 'set');
      const result = await h.runtime.inspect(await h.repository.load());
      expect(result).toEqual({ state, tabCount });
      expect(JSON.stringify(result)).not.toMatch(/fixture|https|id|url|token/);
      expect(h.api.tabs.update).not.toHaveBeenCalled();
      expect(h.api.permissions.contains).not.toHaveBeenCalled();
      expect(h.api.power.requestKeepAwake).not.toHaveBeenCalled();
      expect(h.api.power.releaseKeepAwake).not.toHaveBeenCalled();
      expect(writeLocal).not.toHaveBeenCalled();
      expect(writeSession).not.toHaveBeenCalled();
      expect(await h.runtime.isBackground(7)).toBe(state === 'READY');
    },
  );
  it.each([
    ['disabled', 'ASSISTANT_DISABLED'],
    ['mode', 'AUTO_REPLY_DISABLED'],
    ['background', 'BACKGROUND_DISABLED'],
    ['connection', 'BACKEND_DISCONNECTED'],
  ] as const)(
    'reports the %s setting without implying tab eligibility',
    async (kind, state) => {
      const h = await setup();
      await h.repository.update((settings) => ({
        ...settings,
        ...(kind === 'disabled' ? { enabled: false } : {}),
        ...(kind === 'connection' ? { connections: {} } : {}),
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          ...(kind === 'mode' || kind === 'background'
            ? { backgroundReplies: false, keepAwake: false }
            : {}),
          ...(kind === 'mode'
            ? { replyMode: 'DRAFT_ONLY' as const, webAutoSendOptIn: false }
            : {}),
        })),
      }));
      expect(await h.runtime.inspect(await h.repository.load())).toEqual({
        state,
        tabCount: 1,
      });
      expect(await h.runtime.isBackground(7)).toBe(false);
    },
  );
  it('does not describe a stale or failed tab lookup as ready', async () => {
    const h = await setup();
    h.api.tabs.query.mockImplementationOnce(async () => {
      await h.repository.update((settings) => ({
        ...settings,
        enabled: false,
      }));
      return [{ id: 7, url: 'https://web.whatsapp.com/' }];
    });
    expect(await h.runtime.inspect(await h.repository.load())).toEqual({
      state: 'SETTINGS_CHANGED',
      tabCount: 1,
    });
    h.api.tabs.query.mockRejectedValueOnce(
      new Error('Private browser failure'),
    );
    expect(await h.runtime.inspect(await h.repository.load())).toEqual({
      state: 'CHECK_FAILED',
      tabCount: null,
    });
  });
  it('adds diagnostics to trusted shell snapshots and preserves settings access after a diagnostic failure', async () => {
    const h = await setup();
    const inspect = vi.fn(
      (settings: Awaited<ReturnType<typeof h.repository.load>>) =>
        h.runtime.inspect(settings),
    );
    const route = createMessageRouter(
      h.repository,
      h.session,
      extensionId,
      undefined,
      inspect,
    );
    const result = await route(
      { type: 'GET_STATE', version: 1 },
      trustedSender,
    );
    expect(result.ok && result.state.backgroundRuntime).toEqual({
      state: 'READY',
      tabCount: 1,
    });
    inspect.mockRejectedValueOnce(new Error('Private diagnostic failure'));
    const failed = await route(
      { type: 'GET_STATE', version: 1 },
      trustedSender,
    );
    expect(failed.ok && failed.state.backgroundRuntime).toEqual({
      state: 'CHECK_FAILED',
      tabCount: null,
    });
    expect(JSON.stringify(failed)).not.toContain('Private diagnostic failure');
    inspect.mockClear();
    expect(
      await route(
        { type: 'GET_STATE', version: 1 },
        { ...trustedSender, url: 'https://web.whatsapp.com/' },
      ),
    ).toEqual({ ok: false, error: 'UNAUTHORIZED' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
