import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessProfileSchema } from '@assistant/contracts';
import type { BusinessProfile } from '@assistant/contracts';
import { HandoffInbox, HANDOFF_KEY } from '../src/background/handoff-inbox.js';
import { LiveController } from '../src/background/live-controller.js';
import { createMessageRouter } from '../src/background/message-router.js';
import type { ShellResponse } from '../src/messaging/contracts.js';
import { SettingsRepository } from '../src/storage/settings-repository.js';
import { extensionId, MemoryArea, trustedSender } from './helpers.js';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function stateOf(response: ShellResponse) {
  if (!response.ok) throw new Error(response.error);
  return response.state;
}
const source = (label: string, event = 'a') => ({
  chatKey: 'c'.repeat(64),
  sourceEventKey: event.repeat(64),
  chatLabel: label,
  reason: 'CALLBACK',
  question: label + ' private callback question',
});
async function fixture(raw = false) {
  const local = new MemoryArea();
  const session = new MemoryArea();
  const repository = new SettingsRepository(local);
  await repository.update((settings) => {
    const first = settings.profiles[0]!;
    return {
      ...settings,
      profiles: [
        BusinessProfileSchema.parse({
          ...first,
          privacy: { ...first.privacy, storeRawMessages: raw },
        }),
        BusinessProfileSchema.parse({
          ...first,
          id: 'other-business',
          name: 'Other business',
          privacy: { ...first.privacy, storeRawMessages: raw },
        }),
      ],
    };
  });
  const settings = await repository.load();
  const first = settings.profiles[0]!;
  const other = settings.profiles[1]!;
  const transport = {
    send: vi.fn().mockResolvedValue({ ok: true }),
    notify: vi.fn(),
  };
  const controller = new LiveController(repository, local, transport);
  const route = createMessageRouter(
    repository,
    session,
    extensionId,
    controller,
  );
  const inbox = new HandoffInbox(local);
  const primary = await inbox.create(first, source('Primary customer'));
  const foreign = await inbox.create(other, source('Foreign customer'));
  return {
    local,
    session,
    repository,
    first,
    other,
    transport,
    controller,
    route,
    inbox,
    primary,
    foreign,
  };
}
function profileEdit(profile: BusinessProfile, expectedRevision: number) {
  return {
    profileId: profile.id,
    expectedRevision,
    name: profile.name,
    tone: profile.tone,
    defaultLanguage: profile.defaultLanguage,
    timezone: profile.timezone,
    workingHours: profile.workingHours.description,
    replyMode: profile.replyMode,
    webAutoSendOptIn: profile.webAutoSendOptIn,
    autoOpenUnread: profile.autoOpenUnread,
    includeExistingUnread: profile.includeExistingUnread,
    perChatCooldownSeconds: profile.behavior.perChatCooldownSeconds,
    replyInstructions: profile.replyInstructions,
    businessInformation: profile.businessInformation,
  };
}
describe('admin follow-up trusted-page routing', () => {
  it('defaults existing businesses to the fixed acknowledgement and preserves omitted custom settings', async () => {
    const h = await fixture();
    expect(h.first.followupReply).toBe('');
    expect(h.first.followupCommitmentConfirmed).toBe(false);
    const custom = 'Our team will reach out to you soon.';
    let settings = await h.repository.load();
    stateOf(
      await h.route(
        {
          version: 1,
          type: 'SAVE_PROFILE',
          edit: {
            ...profileEdit(h.first, settings.revision),
            followupReply: custom,
            followupCommitmentConfirmed: true,
          },
        },
        trustedSender,
      ),
    );
    settings = await h.repository.load();
    stateOf(
      await h.route(
        {
          version: 1,
          type: 'SAVE_PROFILE',
          edit: {
            ...profileEdit(settings.profiles[0]!, settings.revision),
            name: 'Updated business',
          },
        },
        trustedSender,
      ),
    );
    const retained = (await h.repository.load()).profiles[0]!;
    expect(retained.followupReply).toBe(custom);
    expect(retained.followupCommitmentConfirmed).toBe(true);
    const switched = stateOf(
      await h.route(
        { version: 1, type: 'SET_ACTIVE_PROFILE', profileId: h.other.id },
        trustedSender,
      ),
    );
    expect(
      switched.settings.profiles.find((profile) => profile.id === h.other.id)
        ?.followupReply,
    ).toBe('');
  });
  it.each([
    'Our team has been notified.',
    'Call us at https://example.com',
    'We will call in 2 hours.',
  ])(
    'rejects unsupported action or exact-fact claims in the custom saved reply: %s',
    async (text) => {
      const h = await fixture();
      const settings = await h.repository.load();
      expect(
        await h.route(
          {
            version: 1,
            type: 'SAVE_PROFILE',
            edit: {
              ...profileEdit(h.first, settings.revision),
              followupReply: text,
              followupCommitmentConfirmed: true,
            },
          },
          trustedSender,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect((await h.repository.load()).profiles[0]?.followupReply).toBe('');
    },
  );
  it.each(['popup.html', 'sidepanel.html', 'options.html'])(
    'returns only active-business handoffs to the owned %s page',
    async (page) => {
      const h = await fixture(true);
      const result = await h.route(
        { version: 1, type: 'GET_STATE' },
        { ...trustedSender, url: `chrome-extension://${extensionId}/${page}` },
      );
      const state = stateOf(result);
      expect(state.handoffs).toEqual([h.primary.record]);
      expect(JSON.stringify(result)).not.toContain(h.foreign.record.id);
      expect(JSON.stringify(result)).not.toContain(
        source('Foreign customer').question,
      );
      const switched = stateOf(
        await h.route(
          { version: 1, type: 'SET_ACTIVE_PROFILE', profileId: h.other.id },
          trustedSender,
        ),
      );
      expect(switched.handoffs).toEqual([h.foreign.record]);
      expect(JSON.stringify(switched.handoffs)).not.toContain(
        h.primary.record.id,
      );
    },
  );
  it('persists a status update across controller, router and settings repository recreation', async () => {
    const h = await fixture();
    const updated = stateOf(
      await h.route(
        {
          version: 1,
          type: 'UPDATE_HANDOFF',
          profileId: h.first.id,
          id: h.primary.record.id,
          status: 'IN_PROGRESS',
        },
        trustedSender,
      ),
    );
    expect(updated.handoffs[0]?.status).toBe('IN_PROGRESS');
    const repository = new SettingsRepository(h.local);
    const restarted = new LiveController(repository, h.local, h.transport);
    const route = createMessageRouter(
      repository,
      new MemoryArea(),
      extensionId,
      restarted,
    );
    expect(
      stateOf(await route({ version: 1, type: 'GET_STATE' }, trustedSender))
        .handoffs[0]?.status,
    ).toBe('IN_PROGRESS');
    expect(
      stateOf(
        await route(
          {
            version: 1,
            type: 'UPDATE_HANDOFF',
            profileId: h.first.id,
            id: h.primary.record.id,
            status: 'RESOLVED',
          },
          trustedSender,
        ),
      ).handoffs[0]?.status,
    ).toBe('RESOLVED');
    expect((await new HandoffInbox(h.local).list(h.first))[0]?.status).toBe(
      'RESOLVED',
    );
  });
  it('rejects both a mismatched requested business and a foreign ticket ID under the active business', async () => {
    const h = await fixture();
    expect(
      await h.route(
        {
          version: 1,
          type: 'UPDATE_HANDOFF',
          profileId: h.other.id,
          id: h.foreign.record.id,
          status: 'RESOLVED',
        },
        trustedSender,
      ),
    ).toEqual({ ok: false, error: 'PROFILE_CHANGED' });
    const foreignId = await h.route(
      {
        version: 1,
        type: 'UPDATE_HANDOFF',
        profileId: h.first.id,
        id: h.foreign.record.id,
        status: 'RESOLVED',
      },
      trustedSender,
    );
    expect(foreignId.ok).toBe(false);
    expect(JSON.stringify(foreignId)).not.toContain(h.foreign.record.chatLabel);
    expect((await h.inbox.list(h.other))[0]?.status).toBe('OPEN');
    expect((await h.inbox.list(h.first))[0]?.status).toBe('OPEN');
  });
  it.each([
    { ...trustedSender, url: 'https://web.whatsapp.com/', tab: { id: 1 } },
    { ...trustedSender, url: 'chrome-extension://foreign/options.html' },
    { ...trustedSender, frameId: 1 },
    {
      ...trustedSender,
      url: `chrome-extension://${extensionId}/service-worker.js`,
    },
  ])(
    'rejects handoff reads and updates from an untrusted sender: $url',
    async (sender) => {
      const h = await fixture();
      expect(await h.route({ version: 1, type: 'GET_STATE' }, sender)).toEqual({
        ok: false,
        error: 'UNAUTHORIZED',
      });
      expect(
        await h.route(
          {
            version: 1,
            type: 'UPDATE_HANDOFF',
            profileId: h.first.id,
            id: h.primary.record.id,
            status: 'RESOLVED',
          },
          sender,
        ),
      ).toEqual({ ok: false, error: 'UNAUTHORIZED' });
      expect((await h.inbox.list(h.first))[0]?.status).toBe('OPEN');
    },
  );
  it('saves optional privacy settings, preserves omitted settings and durably scrubs questions before the revoke response', async () => {
    const h = await fixture();
    let settings = await h.repository.load();
    let saved = stateOf(
      await h.route(
        {
          version: 1,
          type: 'SAVE_PROFILE',
          edit: {
            ...profileEdit(h.first, settings.revision),
            storeRawMessages: true,
            logRetentionDays: 7,
          },
        },
        trustedSender,
      ),
    );
    let current = saved.settings.profiles.find(
      (item) => item.id === h.first.id,
    )!;
    expect(current.privacy).toMatchObject({
      storeRawMessages: true,
      logRetentionDays: 7,
    });
    const sensitiveQuestion = 'Question retained only with explicit opt-in';
    await h.inbox.create(current, {
      ...source('Another customer', 'b'),
      question: sensitiveQuestion,
    });
    expect(JSON.stringify(h.local.values)).toContain(sensitiveQuestion);
    saved = stateOf(
      await h.route(
        {
          version: 1,
          type: 'SAVE_PROFILE',
          edit: profileEdit(current, saved.settings.revision),
        },
        trustedSender,
      ),
    );
    current = saved.settings.profiles.find((item) => item.id === h.first.id)!;
    expect(current.privacy).toMatchObject({
      storeRawMessages: true,
      logRetentionDays: 7,
    });
    expect(
      saved.handoffs.some((row) => row.question === sensitiveQuestion),
    ).toBe(true);
    saved = stateOf(
      await h.route(
        {
          version: 1,
          type: 'SAVE_PROFILE',
          edit: {
            ...profileEdit(current, saved.settings.revision),
            storeRawMessages: false,
          },
        },
        trustedSender,
      ),
    );
    expect(saved.handoffs.every((row) => row.question === undefined)).toBe(
      true,
    );
    expect(JSON.stringify(h.local.values)).not.toContain(sensitiveQuestion);
    settings = await h.repository.load();
    expect(
      settings.profiles.find((item) => item.id === h.first.id)?.privacy
        .storeRawMessages,
    ).toBe(false);
    expect(
      (await new HandoffInbox(h.local).list(settings.profiles[0]!)).every(
        (row) => row.question === undefined,
      ),
    ).toBe(true);
  });
  it.each([
    { status: 'NOTIFIED' },
    { id: 'not-a-uuid' },
    { version: 2 },
    { question: 'Untrusted stored question' },
    { profileId: '' },
  ])(
    'rejects invalid handoff updates without changing durable status: %j',
    async (change) => {
      const h = await fixture();
      expect(
        await h.route(
          {
            version: 1,
            type: 'UPDATE_HANDOFF',
            profileId: h.first.id,
            id: h.primary.record.id,
            status: 'RESOLVED',
            ...change,
          },
          trustedSender,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect((await h.inbox.list(h.first))[0]?.status).toBe('OPEN');
    },
  );
  it.each([0, 366])(
    'rejects an invalid privacy retention of %i days without changing the profile',
    async (days) => {
      const h = await fixture();
      const settings = await h.repository.load();
      expect(
        await h.route(
          {
            version: 1,
            type: 'SAVE_PROFILE',
            edit: {
              ...profileEdit(h.first, settings.revision),
              logRetentionDays: days,
            },
          },
          trustedSender,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
      expect((await h.repository.load()).revision).toBe(settings.revision);
    },
  );
  it('shows a bounded inbox error without exposing storage failure details', async () => {
    const h = await fixture();
    const get = h.local.get.bind(h.local);
    vi.spyOn(h.local, 'get').mockImplementation(async (key) => {
      if (key === HANDOFF_KEY)
        throw new Error('Private backend key or customer data must not escape');
      return get(key);
    });
    const response = await h.route(
      { version: 1, type: 'GET_STATE' },
      trustedSender,
    );
    expect(stateOf(response)).toMatchObject({
      handoffs: [],
      handoffError: 'HANDOFF_STORAGE_FAILED',
    });
    expect(JSON.stringify(response)).not.toContain('Private backend');
  });
});
