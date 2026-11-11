import { describe, expect, it, vi } from 'vitest';
import {
  SettingsRepository,
  SETTINGS_KEY,
} from '../src/storage/settings-repository.js';
import {
  defaultSettings,
  mockProfile,
} from '../src/background/mock-profile.js';
import {
  createMessageRouter,
  DEMO_KEY,
  isTrustedPage,
} from '../src/background/message-router.js';
import { SettingsSchema } from '../src/messaging/contracts.js';
import {
  defaultSelectors,
  legacySelectors,
  selectorsV2,
  selectorsV3,
  selectorsV4,
  selectorsV5,
  selectorsV6,
} from '@assistant/contracts';
import {
  createHarness,
  extensionId,
  MemoryArea,
  trustedSender,
} from './helpers.js';

describe('settings persistence', () => {
  it.each([
    legacySelectors,
    selectorsV2,
    selectorsV3,
    selectorsV4,
    selectorsV5,
    selectorsV6,
  ])(
    'upgrades only the shipped selector pack v$version without losing settings',
    async (pack) => {
      const { local, repository } = createHarness();
      const original = {
        ...defaultSettings(),
        selectors: pack,
        enabled: false,
        connections: {
          'sweet-crumbs-demo': { token: 'fixture-pairing', autoSuggest: true },
        },
      };
      local.values[SETTINGS_KEY] = structuredClone(original);
      const upgraded = await repository.load();
      expect(upgraded.selectors).toEqual(defaultSelectors);
      expect(upgraded.enabled).toBe(false);
      expect(upgraded.connections).toEqual(original.connections);
      expect(upgraded.profiles).toEqual(original.profiles);
      expect((await repository.load()).revision).toBe(upgraded.revision);
      const customized = {
        ...pack,
        messageList: ['#custom-active-list'],
      };
      local.values[SETTINGS_KEY] = { ...original, selectors: customized };
      expect((await repository.load()).selectors).toEqual(customized);
    },
  );
  it('initializes once and restores settings after worker restart', async () => {
    const { repository, local } = createHarness();
    expect((await repository.load()).profiles[0]?.replyMode).toBe('DRAFT_ONLY');
    await repository.update((settings) => ({ ...settings, enabled: false }));
    const restored = await new SettingsRepository(local).load();
    expect(restored.enabled).toBe(false);
    expect(restored.revision).toBe(1);
    expect(restored.profiles[0]?.privacy.storeRawMessages).toBe(false);
  });
  it('serializes concurrent changes without losing unrelated fields', async () => {
    const { repository } = createHarness();
    await Promise.all([
      repository.update((settings) => ({ ...settings, enabled: false })),
      repository.update((settings) => ({
        ...settings,
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          tone: 'formal',
        })),
      })),
    ]);
    const settings = await repository.load();
    expect(settings.enabled).toBe(false);
    expect(settings.profiles[0]?.tone).toBe('formal');
    expect(settings.revision).toBe(2);
  });
  it('preserves invalid stored data rather than silently resetting it', async () => {
    const { local, repository } = createHarness();
    local.values[SETTINGS_KEY] = { version: 999, important: 'keep me' };
    await expect(repository.load()).rejects.toThrow();
    expect(local.values[SETTINGS_KEY]).toEqual({
      version: 999,
      important: 'keep me',
    });
  });
  it('does not poison the queue after a storage write failure', async () => {
    const { local, repository } = createHarness();
    await repository.load();
    vi.spyOn(local, 'set').mockRejectedValueOnce(
      new Error('private internal path'),
    );
    await expect(
      repository.update((settings) => ({ ...settings, enabled: false })),
    ).rejects.toThrow();
    expect((await repository.load()).enabled).toBe(true);
  });
  it('rejects invalid profile selection and web auto-send settings', () => {
    const settings = defaultSettings();
    expect(
      SettingsSchema.safeParse({ ...settings, activeProfileId: 'missing' })
        .success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({
        ...settings,
        profiles: [...settings.profiles, ...settings.profiles],
      }).success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({
        ...settings,
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          replyMode: 'AUTO_SAFE_OFFICIAL_TRANSPORT',
        })),
      }).success,
    ).toBe(false);
  });
});

describe('trusted typed routing', () => {
  it.each(['popup.html', 'sidepanel.html', 'options.html'])(
    'allows the own %s page',
    (page) => {
      expect(
        isTrustedPage(
          {
            ...trustedSender,
            url: `chrome-extension://${extensionId}/${page}`,
          },
          extensionId,
        ),
      ).toBe(true);
    },
  );
  it.each([
    { ...trustedSender, id: 'another-extension' },
    { ...trustedSender, url: 'https://web.whatsapp.com/' },
    { ...trustedSender, url: `chrome-extension://other/options.html` },
    {
      ...trustedSender,
      url: `chrome-extension://${extensionId}/untrusted.html`,
    },
    { ...trustedSender, frameId: 2 },
    { id: extensionId },
  ])('rejects untrusted senders before accessing storage', async (sender) => {
    const { route, local } = createHarness();
    expect(
      await route({ version: 1, type: 'SET_ENABLED', enabled: false }, sender),
    ).toEqual({ ok: false, error: 'UNAUTHORIZED' });
    expect(local.values).toEqual({});
  });
  it('rejects malformed requests and unsupported send events', async () => {
    const { route } = createHarness();
    for (const request of [
      { type: 'GET_STATE' },
      { version: 2, type: 'GET_STATE' },
      { version: 1, type: 'GET_STATE', apiKey: 'untrusted' },
      { version: 1, type: 'SEND_REPLY_REQUESTED', payload: {} },
    ]) {
      expect(await route(request, trustedSender)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      });
    }
  });
  it('produces a scoped typed mock event that survives worker recreation', async () => {
    const { repository, route, session } = createHarness();
    const response = await route(
      { version: 1, type: 'RUN_MOCK', profileId: 'sweet-crumbs-demo' },
      trustedSender,
    );
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('Expected sample state');
    expect(response.state.demo?.event.type).toBe('ASSISTANT_DECISION_READY');
    expect(response.state.demo?.profileId).toBe(
      response.state.settings.activeProfileId,
    );
    const event = response.state.demo?.event;
    if (event?.type !== 'ASSISTANT_DECISION_READY')
      throw new Error('Expected a decision event');
    expect(event.payload.decision.kind).toBe('ANSWER');
    if (event.payload.decision.kind !== 'ANSWER')
      throw new Error('Expected answer');
    expect(event.payload.decision.reply).toContain('₹650 for 500 grams');
    expect(event.payload.decision.sendPolicy).toBe('DRAFT');
    expect(event.payload.chatKey).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await createMessageRouter(
        repository,
        session,
        extensionId,
      )({ version: 1, type: 'GET_STATE' }, trustedSender),
    ).toEqual(response);
  });
  it('blocks sample actions when disabled or profile mismatched', async () => {
    const { route, repository, session } = createHarness();
    expect(
      await route(
        { version: 1, type: 'RUN_MOCK', profileId: 'other' },
        trustedSender,
      ),
    ).toEqual({ ok: false, error: 'PROFILE_CHANGED' });
    await repository.update((settings) => ({ ...settings, enabled: false }));
    expect(
      await route(
        { version: 1, type: 'RUN_MOCK', profileId: 'sweet-crumbs-demo' },
        trustedSender,
      ),
    ).toEqual({ ok: false, error: 'DISABLED' });
    expect(session.values[DEMO_KEY]).toBeUndefined();
  });
  it('does not surface another profile’s cached sample', async () => {
    const { route, repository } = createHarness();
    await route(
      { version: 1, type: 'RUN_MOCK', profileId: 'sweet-crumbs-demo' },
      trustedSender,
    );
    await repository.update((settings) => ({
      ...settings,
      profiles: [...settings.profiles, { ...mockProfile, id: 'second-demo' }],
      activeProfileId: 'second-demo',
    }));
    const response = await route(
      { version: 1, type: 'GET_STATE' },
      trustedSender,
    );
    expect(response.ok && response.state.demo).toBe(null);
  });
  it('rejects a stale settings edit without overwriting changes', async () => {
    const { route, repository } = createHarness();
    const original = (await repository.load()).profiles[0];
    if (!original) throw new Error('Expected mock profile');
    await route(
      { version: 1, type: 'SET_ENABLED', enabled: false },
      trustedSender,
    );
    const response = await route(
      {
        version: 1,
        type: 'SAVE_PROFILE',
        edit: {
          profileId: original.id,
          expectedRevision: 0,
          name: 'Stale name',
          tone: 'formal',
          defaultLanguage: 'en',
          timezone: original.timezone,
          workingHours: '9–5',
          replyMode: 'DRAFT_ONLY',
        },
      },
      trustedSender,
    );
    expect(response).toEqual({ ok: false, error: 'CONFLICT' });
    expect((await repository.load()).profiles[0]?.name).toBe(original.name);
  });
  it('returns a bounded error when storage fails, without leaking internals', async () => {
    const local = new MemoryArea();
    vi.spyOn(local, 'get').mockRejectedValue(
      new Error('sensitive internal information'),
    );
    const route = createMessageRouter(
      new SettingsRepository(local),
      new MemoryArea(),
      extensionId,
    );
    expect(
      await route({ version: 1, type: 'GET_STATE' }, trustedSender),
    ).toEqual({ ok: false, error: 'STORAGE_ERROR' });
  });
});
