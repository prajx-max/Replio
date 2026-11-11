import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveController } from '../src/background/live-controller.js';
import { BackendClient } from '../src/background/backend-client.js';
import { createHarness } from './helpers.js';
import { createMessageRouter } from '../src/background/message-router.js';
import { extensionId, trustedSender } from './helpers.js';
import {
  AutoSendCommandSchema,
  UnreadOpenResultSchema,
  AdapterStatusSchema,
} from '@assistant/contracts';
import type { AdapterContext, AdapterStatus } from '@assistant/contracts';
import { digest, DELIVERY_KEY } from '../src/background/delivery-journal.js';
import { handoffAcknowledgement } from '@assistant/core';
import { HANDOFF_KEY } from '../src/background/handoff-inbox.js';
import { BackendFailure } from '../src/background/backend-client.js';

const context: AdapterContext = {
  profileId: 'sweet-crumbs-demo',
  contextId: 'fixture-context',
  chatKey: 'a'.repeat(64),
  chatLabel: 'Fixture customer',
};
const status: AdapterStatus = {
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
    sendButton: 0,
  },
};
async function setup(delayed?: Promise<Response>, automatic = false) {
  const harness = createHarness();
  if (automatic)
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        replyMode: 'AUTO_REPLY_WEB',
        webAutoSendOptIn: true,
      })),
    }));
  const calls: string[] = [];
  const synced: unknown[] = [];
  const output = { needsHuman: false, reply: 'A verified fixture reply.' };
  const requests: { requestId: string; text: string }[] = [];
  let firstPending = delayed;
  const backend = new BackendClient(async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/api/status'))
      return Response.json({
        configured: true,
        provider: 'openai',
        model: 'fixture-model',
      });
    if (url.endsWith('/api/profiles')) {
      synced.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    const request = JSON.parse(String(init?.body)) as {
      requestId: string;
      text: string;
    };
    requests.push(request);
    if (firstPending) {
      const response = firstPending;
      firstPending = undefined;
      return response;
    }
    return Response.json({
      requestId: request.requestId,
      reply: output.reply,
      needsHuman: output.needsHuman,
      grounded: true,
      provider: 'openai',
      model: 'fixture-model',
    });
  });
  const isActive = vi.fn().mockResolvedValue(true);
  const isBackground = vi.fn().mockResolvedValue(false);
  const reconnect = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn<(tabId: number, message: unknown) => Promise<unknown>>(
    async (tabId, message) => {
      const command = AutoSendCommandSchema.safeParse(message);
      if (!command.success) return { ok: true };
      const authorization = await controller.handle(
        {
          type: 'ADAPTER_AUTHORIZE_SEND',
          version: 1,
          context: command.data.context,
          sourceEventKey: command.data.sourceEventKey,
          deliveryId: command.data.deliveryId,
          replyHash: await digest(command.data.text),
        },
        tabId,
      );
      expect(authorization).toEqual({ ok: true });
      return { state: 'SENT', reason: 'ACCEPTED_BY_WHATSAPP' };
    },
  );
  const controller = new LiveController(
    harness.repository,
    harness.local,
    { send, isActive, isBackground, reconnect, notify: vi.fn() },
    backend,
  );
  await controller.connect('fixture-pairing-code', true);
  await controller.handle({ type: 'ADAPTER_STATUS', version: 1, status }, 1);
  return {
    ...harness,
    controller,
    calls,
    send,
    isActive,
    isBackground,
    synced,
    output,
    backend,
    requests,
  };
}

afterEach(() => vi.restoreAllMocks());

const incoming = (eventKey = 'e'.repeat(64)) =>
  ({
    type: 'ADAPTER_MESSAGE',
    version: 1,
    context,
    eventKey,
    text: 'A fresh question',
  }) as const;
async function delivery(
  harness: Awaited<ReturnType<typeof setup>>,
  state: string,
) {
  await vi.waitFor(async () =>
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.delivery?.state,
    ).toBe(state),
  );
}
describe('background automatic reply authorization', () => {
  async function enableBackground(h: Awaited<ReturnType<typeof setup>>) {
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        backgroundReplies: true,
      })),
    }));
    h.isActive.mockResolvedValue(false);
    h.isBackground.mockResolvedValue(true);
  }
  it('bootstraps background capability only for explicitly opted-in automatic replies', async () => {
    const h = await setup(undefined, true);
    expect(await h.controller.bootstrap()).toMatchObject({
      backgroundReplies: false,
    });
    await enableBackground(h);
    expect(await h.controller.bootstrap()).toMatchObject({
      backgroundReplies: true,
    });
    await h.repository.update((settings) => ({ ...settings, enabled: false }));
    expect(await h.controller.bootstrap()).toMatchObject({
      backgroundReplies: false,
    });
  });
  it('sends a fresh inactive-tab reply through normal final authorization', async () => {
    const h = await setup(undefined, true);
    await enableBackground(h);
    await h.controller.handle(incoming(), 1);
    await delivery(h, 'SENT');
    expect(h.requests).toHaveLength(1);
    expect(h.isBackground).toHaveBeenCalledWith(1);
    expect(h.isActive).not.toHaveBeenCalled();
  });
  it('rejects a non-owner before deduplication and allows the same fresh source after ownership is verified', async () => {
    const h = await setup(undefined, true);
    await enableBackground(h);
    h.isBackground.mockResolvedValue(false);
    expect(await h.controller.handle(incoming(), 1)).toEqual({ ok: false });
    expect(h.requests).toHaveLength(0);
    expect(h.local.values['assistant.seen.v1']).toBeUndefined();
    h.isBackground.mockResolvedValue(true);
    await h.controller.handle(incoming(), 1);
    await delivery(h, 'SENT');
  });
  it('revokes final native-send authorization when background permission is turned off', async () => {
    const h = await setup(undefined, true);
    await enableBackground(h);
    h.send.mockImplementation(async (tabId, raw) => {
      const command = AutoSendCommandSchema.parse(raw);
      await h.repository.update((settings) => ({
        ...settings,
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          backgroundReplies: false,
          keepAwake: false,
        })),
      }));
      expect(
        await h.controller.handle(
          {
            type: 'ADAPTER_AUTHORIZE_SEND',
            version: 1,
            context: command.context,
            sourceEventKey: command.sourceEventKey,
            deliveryId: command.deliveryId,
            replyHash: await digest(command.text),
          },
          tabId,
        ),
      ).toEqual({ ok: false });
      return { state: 'BLOCKED', reason: 'AUTHORIZATION_REVOKED' };
    });
    await h.controller.handle(incoming(), 1);
    await delivery(h, 'BLOCKED');
  });
  it('still blocks a background chat under human takeover', async () => {
    const h = await setup(undefined, true);
    await enableBackground(h);
    await h.controller.setTakeover(context, true);
    await h.controller.handle(incoming(), 1);
    expect(h.requests).toHaveLength(0);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('rejects stale intake before reserving a source when a pause is saved during background lookup', async () => {
    const h = await setup(undefined, true);
    await enableBackground(h);
    h.isBackground.mockImplementationOnce(async () => {
      await h.controller.setTakeover(context, true);
      return true;
    });
    expect(
      await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1),
    ).toEqual({ ok: false });
    expect(h.local.values['assistant.seen.v1']).toBeUndefined();
    expect(h.local.values[HANDOFF_KEY]).toBeUndefined();
    expect(h.requests).toHaveLength(0);
    expect(
      h.controller.snapshot(await h.repository.load()).live?.message,
    ).toBeNull();
  });
  it('does not save a callback or schedule work when a pause arrives during source persistence', async () => {
    const h = await setup(undefined, true);
    await enableBackground(h);
    const save = h.local.set.bind(h.local);
    vi.spyOn(h.local, 'set').mockImplementation(async (values) => {
      await save(values);
      if ('assistant.seen.v1' in values)
        await h.controller.setTakeover(context, true);
    });
    expect(
      await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1),
    ).toEqual({ ok: true });
    expect(h.local.values['assistant.seen.v1']).toBeDefined();
    expect(h.local.values[HANDOFF_KEY]).toBeUndefined();
    expect(h.requests).toHaveLength(0);
    expect(
      h.controller.snapshot(await h.repository.load()).live?.message,
    ).toBeNull();
  });
});

describe('opening newly unread chats', () => {
  it('applies saved unread consent to open tabs even before a restarted worker has received a status report', async () => {
    const h = createHarness();
    const settings = await h.repository.load();
    const profile = settings.profiles[0]!;
    const applied = vi.fn();
    const reconnect = vi.fn(async () => {
      const config = await controller.handle(
        { version: 1, type: 'ADAPTER_BOOTSTRAP' },
        7,
      );
      applied(config);
    });
    const controller = new LiveController(h.repository, h.local, {
      send: vi.fn(),
      notify: vi.fn(),
      reconnect,
    });
    const route = createMessageRouter(
      h.repository,
      h.session,
      extensionId,
      controller,
    );
    const result = await route(
      {
        version: 1,
        type: 'SAVE_PROFILE',
        edit: {
          profileId: profile.id,
          expectedRevision: settings.revision,
          name: profile.name,
          tone: profile.tone,
          defaultLanguage: profile.defaultLanguage,
          timezone: profile.timezone,
          workingHours: profile.workingHours.description,
          replyMode: 'AUTO_REPLY_WEB',
          webAutoSendOptIn: true,
          autoOpenUnread: true,
          includeExistingUnread: true,
          replyInstructions: profile.replyInstructions,
          businessInformation: profile.businessInformation,
        },
      },
      trustedSender,
    );
    expect(result.ok).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: profile.id,
        autoOpenUnread: true,
        autoSendEnabled: true,
        includeExistingUnread: true,
      }),
    );
  });
  const destination = {
    ...context,
    contextId: 'opened-chat',
    chatKey: 'b'.repeat(64),
    titleKey: 'c'.repeat(64),
    chatLabel: 'Unread customer',
  };
  const candidate = () =>
    ({
      type: 'ADAPTER_OPEN_UNREAD',
      version: 1,
      profileId: context.profileId,
      fromContextId: context.contextId,
      titleKey: destination.titleKey,
      targetKey: destination.chatKey,
      observedAt: Date.now(),
    }) as const;
  async function enabled() {
    const harness = await setup(undefined, true);
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        autoOpenUnread: true,
      })),
    }));
    return harness;
  }
  async function permission(controller: LiveController) {
    const answer = UnreadOpenResultSchema.parse(
      await controller.handle(candidate(), 1),
    );
    if (answer.state !== 'OPEN')
      throw new Error('Expected unread navigation grant');
    return answer.grantId;
  }
  it('opens a background unread chat only with consent and admits its proof only while it remains the unique owner', async () => {
    const h = await enabled();
    h.isActive.mockResolvedValue(false);
    h.isBackground.mockResolvedValue(true);
    expect(await h.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'TAB_NOT_ELIGIBLE',
    });
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        backgroundReplies: true,
      })),
    }));
    const grantId = await permission(h.controller);
    await h.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: destination },
      },
      1,
    );
    h.isBackground.mockResolvedValue(false);
    expect(
      await h.controller.handle(
        { ...incoming(), context: destination, unreadGrantId: grantId },
        1,
      ),
    ).toEqual({ ok: false });
    expect(h.requests).toHaveLength(0);
    h.isBackground.mockResolvedValue(true);
    expect(
      await h.controller.handle(
        { ...incoming(), context: destination, unreadGrantId: grantId },
        1,
      ),
    ).toEqual({ ok: true });
    await delivery(h, 'SENT');
  });
  it('waits for the current chat hydration instead of discarding the unread candidate', async () => {
    const h = await enabled();
    await h.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, ready: false },
      },
      1,
    );
    expect(await h.controller.handle(candidate(), 1)).toEqual({
      state: 'WAIT',
    });
    expect(h.calls.filter((url) => url.endsWith('/api/status'))).toHaveLength(
      1,
    );
    await h.controller.handle(
      { type: 'ADAPTER_STATUS', version: 1, status },
      1,
    );
    expect(await h.controller.handle(candidate(), 1)).toMatchObject({
      state: 'OPEN',
    });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps an unopened existing candidate through a brief backend outage, then grants one proved reply', async () => {
    const h = await enabled();
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        includeExistingUnread: true,
        backgroundReplies: true,
      })),
    }));
    h.isActive.mockResolvedValue(false);
    h.isBackground.mockResolvedValue(true);
    const check = vi
      .spyOn(h.backend, 'status')
      .mockRejectedValueOnce(new BackendFailure('BACKEND_OFFLINE'));
    const request = { ...candidate(), existingUnread: true as const };
    expect(await h.controller.handle(request, 1)).toEqual({
      state: 'WAIT',
      reason: 'BACKEND_OFFLINE',
    });
    expect(check).toHaveBeenCalledWith('fixture-pairing-code', 2000);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    const granted = UnreadOpenResultSchema.parse(
      await h.controller.handle(request, 1),
    );
    if (granted.state !== 'OPEN') throw new Error('Missing recovered grant');
    await h.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: destination },
      },
      1,
    );
    const source = {
      ...incoming(),
      context: destination,
      unreadGrantId: granted.grantId,
    };
    expect(await h.controller.handle(source, 1)).toEqual({ ok: true });
    await delivery(h, 'SENT');
    expect(await h.controller.handle(source, 1)).toEqual({ ok: false });
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it.each(['pause', 'revoke-existing-consent'] as const)(
    'does not retry navigation after offline waiting followed by %s',
    async (change) => {
      const h = await enabled();
      await h.repository.update((settings) => ({
        ...settings,
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          includeExistingUnread: true,
        })),
      }));
      const check = vi
        .spyOn(h.backend, 'status')
        .mockRejectedValueOnce(new BackendFailure('BACKEND_OFFLINE'));
      const request = { ...candidate(), existingUnread: true as const };
      expect(await h.controller.handle(request, 1)).toEqual({
        state: 'WAIT',
        reason: 'BACKEND_OFFLINE',
      });
      if (change === 'pause') await h.controller.setTakeover(context, true);
      else
        await h.repository.update((settings) => ({
          ...settings,
          profiles: settings.profiles.map((profile) => ({
            ...profile,
            includeExistingUnread: false,
          })),
        }));
      expect(await h.controller.handle(request, 1)).toEqual({
        state: 'SKIP',
        reason: change === 'pause' ? 'SOURCE_PAUSED' : 'POLICY_DISABLED',
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(h.send).not.toHaveBeenCalled();
    },
  );
  it('keeps permanent pairing and configuration failures out of the outage retry path', async () => {
    const h = await enabled();
    const check = vi.spyOn(h.backend, 'status');
    check.mockRejectedValueOnce(new BackendFailure('UNAUTHORIZED'));
    expect(await h.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'BACKEND_REJECTED',
    });
    check.mockResolvedValueOnce({
      configured: false,
      provider: null,
      model: '',
    });
    expect(await h.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'BACKEND_NOT_CONFIGURED',
    });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('requires existing-unread consent when granting a baseline opening and revokes the grant on a settings change', async () => {
    const h = await enabled();
    const request = { ...candidate(), existingUnread: true as const };
    expect(await h.controller.handle(request, 1)).toEqual({
      state: 'SKIP',
      reason: 'POLICY_DISABLED',
    });
    const consent = (allow: boolean) =>
      h.repository.update((settings) => ({
        ...settings,
        profiles: settings.profiles.map((p) => ({
          ...p,
          includeExistingUnread: allow,
        })),
      }));
    await consent(true);
    expect(await h.controller.bootstrap()).toMatchObject({
      includeExistingUnread: true,
    });
    const granted = UnreadOpenResultSchema.parse(
      await h.controller.handle(request, 1),
    );
    if (granted.state !== 'OPEN')
      throw new Error('Expected an existing-unread grant');
    await consent(false);
    await h.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: destination },
      },
      1,
    );
    expect(
      await h.controller.handle(
        { ...incoming(), context: destination, unreadGrantId: granted.grantId },
        1,
      ),
    ).toEqual({ ok: false });
    expect(h.requests).toHaveLength(0);
  });
  it('requires separate consent, an active trusted tab and a live, owned origin context', async () => {
    const { controller } = await setup(undefined, true);
    expect(await controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'POLICY_DISABLED',
    });
    const harness = await enabled();
    expect(await harness.controller.handle(candidate(), 2)).toEqual({
      state: 'SKIP',
      reason: 'SOURCE_CHANGED',
    });
    expect(
      await harness.controller.handle(
        { ...candidate(), fromContextId: 'replaced' },
        1,
      ),
    ).toEqual({ state: 'SKIP', reason: 'SOURCE_CHANGED' });
    expect(
      await harness.controller.handle({ ...candidate(), observedAt: 1 }, 1),
    ).toEqual({ state: 'SKIP', reason: 'SOURCE_EXPIRED' });
    harness.isActive.mockResolvedValue(false);
    expect(await harness.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'TAB_NOT_ELIGIBLE',
    });
  });
  it('leaves the unread badge alone when pairing fails or business hours are closed', async () => {
    const harness = await enabled();
    const check = vi
      .spyOn(harness.backend, 'status')
      .mockRejectedValueOnce(new Error('UNAUTHORIZED'));
    expect(await harness.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'BACKEND_REJECTED',
    });
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        workingHours: {
          description: 'Closed',
          outsideHoursAction: 'DRAFT',
          schedule: [{ day: 0, opens: '00:00', closes: '00:00' }],
        },
      })),
    }));
    expect(await harness.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'OUTSIDE_HOURS',
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(harness.requests).toHaveLength(0);
  });
  it('respects pause on either chat including a title-only sidebar row for a paused public-ID chat', async () => {
    const harness = await enabled();
    await harness.controller.setTakeover(context, true);
    expect(await harness.controller.handle(candidate(), 1)).toEqual({
      state: 'SKIP',
      reason: 'SOURCE_PAUSED',
    });
    await harness.controller.setTakeover(context, false);
    await harness.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: destination },
      },
      1,
    );
    await harness.controller.setTakeover(destination, true);
    await harness.controller.handle(
      { type: 'ADAPTER_STATUS', version: 1, status },
      1,
    );
    const { targetKey, ...titleOnly } = candidate();
    expect(targetKey).toBe(destination.chatKey);
    expect(await harness.controller.handle(titleOnly, 1)).toEqual({
      state: 'SKIP',
      reason: 'TARGET_PAUSED',
    });
  });
  it('retains an unread candidate when reconnecting advances only the preflight revision, then grants a fresh proved reply', async () => {
    const h = await enabled();
    const check = vi
      .spyOn(h.backend, 'status')
      .mockImplementationOnce(async () => {
        // Connecting with the saved credential updates revision but does not
        // replace the observer or its currently verified source context.
        await h.controller.connect('', true);
        return { configured: true, provider: 'openai', model: 'fixture-model' };
      });
    const request = candidate();
    const first = await h.controller.handle(request, 1);
    expect(first).toEqual({ state: 'WAIT', reason: 'POLICY_CHANGED' });
    expect(UnreadOpenResultSchema.parse(first)).not.toHaveProperty('grantId');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(0);
    const second = UnreadOpenResultSchema.parse(
      await h.controller.handle(request, 1),
    );
    if (second.state !== 'OPEN')
      throw new Error('Missing fresh revalidated grant');
    expect(check).toHaveBeenCalledTimes(3);
    await h.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: destination },
      },
      1,
    );
    await h.controller.handle(
      { ...incoming(), context: destination, unreadGrantId: second.grantId },
      1,
    );
    await delivery(h, 'SENT');
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it.each(['pause', 'consent'] as const)(
    'rechecks %s before any grant after a policy-change wait',
    async (change) => {
      const h = await enabled();
      const check = vi
        .spyOn(h.backend, 'status')
        .mockImplementationOnce(async () => {
          if (change === 'pause') await h.controller.setTakeover(context, true);
          else
            await h.repository.update((settings) => ({
              ...settings,
              profiles: settings.profiles.map((profile) => ({
                ...profile,
                autoOpenUnread: false,
              })),
            }));
          return {
            configured: true,
            provider: 'openai',
            model: 'fixture-model',
          };
        });
      const request = candidate();
      expect(await h.controller.handle(request, 1)).toEqual({
        state: 'WAIT',
        reason: 'POLICY_CHANGED',
      });
      expect(await h.controller.handle(request, 1)).toEqual({
        state: 'SKIP',
        reason: change === 'pause' ? 'SOURCE_PAUSED' : 'POLICY_DISABLED',
      });
      expect(check).toHaveBeenCalledTimes(1);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(0);
    },
  );
  it.each(['source', 'tab'] as const)(
    'does not retry a revision change when the %s is no longer eligible',
    async (change) => {
      const h = await enabled();
      vi.spyOn(h.backend, 'status').mockImplementationOnce(async () => {
        await h.repository.update((settings) => settings);
        if (change === 'source') h.controller.forget(1);
        else h.isActive.mockResolvedValue(false);
        return { configured: true, provider: 'openai', model: 'fixture-model' };
      });
      expect(await h.controller.handle(candidate(), 1)).toEqual({
        state: 'SKIP',
        reason: change === 'source' ? 'SOURCE_CHANGED' : 'TAB_NOT_ELIGIBLE',
      });
      expect(h.send).not.toHaveBeenCalled();
    },
  );
  it('explains an unidentifiable legacy pause without weakening title-only destination protection', async () => {
    const h = await enabled();
    const unknown = 'd'.repeat(64);
    await h.repository.update((settings) => ({
      ...settings,
      takeovers: {
        [unknown]: {
          profileId: context.profileId,
          chatKey: unknown,
          pausedAt: Date.now(),
        },
      },
    }));
    const { targetKey, ...titleOnly } = candidate();
    expect(targetKey).toBe(destination.chatKey);
    expect(await h.controller.handle(titleOnly, 1)).toEqual({
      state: 'SKIP',
      reason: 'PAUSE_IDENTITY_UNKNOWN',
    });
    expect(await h.controller.handle(candidate(), 1)).toMatchObject({
      state: 'OPEN',
    });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps unread reasons bounded to approved enums and accepts legacy reason-free replies', () => {
    expect(UnreadOpenResultSchema.parse({ state: 'SKIP' })).toEqual({
      state: 'SKIP',
    });
    expect(
      UnreadOpenResultSchema.safeParse({
        state: 'WAIT',
        reason: 'POLICY_CHANGED',
      }).success,
    ).toBe(true);
    expect(
      UnreadOpenResultSchema.safeParse({
        state: 'SKIP',
        reason: 'private customer label',
      }).success,
    ).toBe(false);
    expect(
      UnreadOpenResultSchema.safeParse({
        state: 'WAIT',
        reason: 'private backend exception',
      }).success,
    ).toBe(false);
    const diagnostics = {
      visible: true,
      lastVisibleListFound: true,
      lastVisibleRows: 2,
      lastVisibleUnreadRows: 1,
      initialScanPending: false,
      existingUnreadQueued: 0,
      lastSkipReason: 'TARGET_PAUSED',
    };
    expect(
      AdapterStatusSchema.safeParse({
        ...status,
        unreadDiagnostics: diagnostics,
      }).success,
    ).toBe(true);
    expect(
      AdapterStatusSchema.safeParse({
        ...status,
        unreadDiagnostics: {
          ...diagnostics,
          lastSkipReason: 'private customer label',
        },
      }).success,
    ).toBe(false);
  });
  it.each([
    'profile revision',
    'different chat',
    'wrong title',
    'worker restart',
  ])('rejects unread admission after %s', async (change) => {
    const harness = await enabled();
    const id = await permission(harness.controller);
    if (change === 'profile revision')
      await harness.repository.update((settings) => settings);
    const controller =
      change === 'worker restart'
        ? new LiveController(
            harness.repository,
            harness.local,
            { send: harness.send, isActive: harness.isActive, notify: vi.fn() },
            harness.backend,
          )
        : harness.controller;
    const actual = {
      ...destination,
      ...(change === 'different chat'
        ? { chatKey: 'd'.repeat(64) }
        : change === 'wrong title'
          ? { titleKey: 'f'.repeat(64) }
          : {}),
    };
    await controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: actual },
      },
      1,
    );
    expect(
      await controller.handle(
        { ...incoming(), context: actual, unreadGrantId: id },
        1,
      ),
    ).toEqual({ ok: false });
    expect(harness.requests).toHaveLength(0);
  });
  it('uses the original arrival time, permits only one source and waits before leaving an ongoing reply', async () => {
    const harness = await enabled();
    const request = { ...candidate(), observedAt: Date.now() - 1000 };
    const grant = UnreadOpenResultSchema.parse(
      await harness.controller.handle(request, 1),
    );
    if (grant.state !== 'OPEN')
      throw new Error('Expected unread navigation grant');
    await harness.controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: { ...status, context: destination },
      },
      1,
    );
    await harness.controller.handle(
      { ...incoming(), context: destination, unreadGrantId: grant.grantId },
      1,
    );
    await delivery(harness, 'SENT');
    expect(
      harness.controller.snapshot(await harness.repository.load()).live?.message
        ?.receivedAt,
    ).toBe(request.observedAt);
    expect(
      await harness.controller.handle(
        {
          ...incoming('f'.repeat(64)),
          context: destination,
          unreadGrantId: grant.grantId,
        },
        1,
      ),
    ).toEqual({ ok: false });
    await harness.controller.handle(
      { ...incoming('9'.repeat(64)), context: destination },
      1,
    );
    expect(
      await harness.controller.handle(
        {
          ...candidate(),
          fromContextId: destination.contextId,
          titleKey: '2'.repeat(64),
          targetKey: '3'.repeat(64),
        },
        1,
      ),
    ).toEqual({ state: 'WAIT' });
    expect(harness.requests).toHaveLength(1);
    expect(JSON.stringify(harness.synced)).not.toContain('autoOpenUnread');
  });
});
describe('cooldown continuation and cancellation', () => {
  const baseTime = 1800000000000;
  async function queued() {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    const harness = await setup(undefined, true);
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'SENT');
    clock.mockReturnValue(baseTime + 100);
    const ack = await harness.controller.handle(
      { ...incoming('f'.repeat(64)), text: 'Second question' },
      1,
    );
    expect(ack).toEqual({ ok: true, pollAfterMs: 1000 });
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.state,
    ).toBe('WAITING');
    return { ...harness, clock };
  }
  it('waits for the persisted send cooldown and coalesces a burst into its latest message', async () => {
    const harness = await queued();
    harness.clock.mockReturnValue(baseTime + 3000);
    await harness.controller.handle(
      { ...incoming('d'.repeat(64)), text: 'Newest question in burst' },
      1,
    );
    await harness.controller.handle(
      { type: 'ADAPTER_POLL', version: 1, context },
      1,
    );
    expect(harness.requests).toHaveLength(1);
    const duplicate = await harness.controller.handle(
      incoming('d'.repeat(64)),
      1,
    );
    expect(duplicate).toEqual({ ok: true, pollAfterMs: 1000 });
    harness.clock.mockReturnValue(baseTime + 10001);
    await harness.controller.handle(
      { type: 'ADAPTER_POLL', version: 1, context },
      1,
    );
    await delivery(harness, 'SENT');
    expect(harness.requests.map((request) => request.text)).toEqual([
      'A fresh question',
      'Newest question in burst',
    ]);
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(harness.local.values)).not.toContain(
      'Newest question in burst',
    );
  });
  it('coalesces an in-flight request without adding a delay when cooldown is zero', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const harness = await setup(delayed, true);
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        behavior: { ...profile.behavior, perChatCooldownSeconds: 0 },
      })),
    }));
    await harness.controller.handle(
      { ...incoming(), text: 'First zero-cooldown question' },
      1,
    );
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    await harness.controller.handle(
      { ...incoming('f'.repeat(64)), text: 'Latest zero-cooldown question' },
      1,
    );
    expect(harness.requests).toHaveLength(1);
    finish(
      Response.json({
        requestId: harness.requests[0]?.requestId,
        reply: 'Obsolete answer',
        needsHuman: false,
        grounded: true,
        provider: 'openai',
        model: 'fixture-model',
      }),
    );
    await delivery(harness, 'SENT');
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]?.text).toBe('Latest zero-cooldown question');
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    'pause',
    'disabled',
    'chat-switch',
    'tab-close',
    'reset',
    'reconnect',
  ] as const)('cancels queued automatic work on %s', async (reason) => {
    const harness = await queued();
    if (reason === 'pause') await harness.controller.setTakeover(context, true);
    if (reason === 'disabled')
      await harness.repository.update((settings) => ({
        ...settings,
        enabled: false,
      }));
    if (reason === 'chat-switch')
      await harness.controller.handle(
        {
          type: 'ADAPTER_STATUS',
          version: 1,
          status: {
            ...status,
            context: {
              ...context,
              contextId: 'different-chat',
              chatKey: 'b'.repeat(64),
            },
          },
        },
        1,
      );
    if (reason === 'tab-close') harness.controller.forget(1);
    if (reason === 'reset') await harness.controller.reset();
    if (reason === 'reconnect') await harness.controller.reconnect();
    harness.clock.mockReturnValue(baseTime + 11000);
    await harness.controller.handle(
      { type: 'ADAPTER_POLL', version: 1, context },
      1,
    );
    expect(harness.requests).toHaveLength(1);
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.state,
    ).not.toBe('WAITING');
    if (reason === 'pause') {
      await harness.controller.setTakeover(context, false);
      expect(
        await harness.controller.handle(
          { type: 'ADAPTER_POLL', version: 1, context },
          1,
        ),
      ).toEqual({ ok: false });
      expect(harness.requests).toHaveLength(1);
    }
  });
  it('expires queued messages and allows only a manual draft afterward', async () => {
    const harness = await queued();
    harness.clock.mockReturnValue(baseTime + 121000);
    await harness.controller.handle(
      { type: 'ADAPTER_POLL', version: 1, context },
      1,
    );
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.error,
    ).toBe('MESSAGE_EXPIRED');
    await harness.controller.retry();
    await vi.waitFor(async () =>
      expect(
        harness.controller.snapshot(await harness.repository.load()).live
          ?.suggestion?.state,
      ).toBe('READY'),
    );
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
  it('reports an overlong interval without leaving work queued indefinitely', async () => {
    const harness = await setup(undefined, true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        behavior: { ...profile.behavior, perChatCooldownSeconds: 3600 },
      })),
    }));
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'SENT');
    clock.mockReturnValue(baseTime + 100);
    await harness.controller.handle(incoming('f'.repeat(64)), 1);
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.error,
    ).toBe('COOLDOWN_TOO_LONG');
    expect(harness.requests).toHaveLength(1);
  });
  it('validates polling ownership and drops pending raw text after worker recreation', async () => {
    const harness = await queued();
    for (const bad of [
      { ...context, profileId: 'other-business' },
      { ...context, chatKey: 'c'.repeat(64) },
      { ...context, contextId: 'different-context' },
    ])
      expect(
        await harness.controller.handle(
          { type: 'ADAPTER_POLL', version: 1, context: bad },
          1,
        ),
      ).toEqual({ ok: false });
    expect(
      await harness.controller.handle(
        { type: 'ADAPTER_POLL', version: 1, context },
        2,
      ),
    ).toEqual({ ok: false });
    const send = vi
      .fn()
      .mockResolvedValue({ state: 'SENT', reason: 'ACCEPTED_BY_WHATSAPP' });
    const restarted = new LiveController(
      harness.repository,
      harness.local,
      { send, isActive: harness.isActive, notify: vi.fn() },
      harness.backend,
    );
    await restarted.handle({ type: 'ADAPTER_STATUS', version: 1, status }, 1);
    expect(
      await restarted.handle({ type: 'ADAPTER_POLL', version: 1, context }, 1),
    ).toEqual({ ok: false });
    await restarted.handle(incoming('f'.repeat(64)), 1);
    expect(
      restarted.snapshot(await harness.repository.load()).live?.message,
    ).toBeNull();
    // A fresh event after restart still honors the journal's send cooldown.
    await restarted.handle(incoming('d'.repeat(64)), 1);
    expect(
      restarted.snapshot(await harness.repository.load()).live?.suggestion
        ?.state,
    ).toBe('WAITING');
    expect(harness.requests).toHaveLength(1);
    harness.clock.mockReturnValue(baseTime + 10001);
    await restarted.handle({ type: 'ADAPTER_POLL', version: 1, context }, 1);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(harness.requests).toHaveLength(2);
  });
});

describe('durable admin handoffs in live replies', () => {
  it.each(['inactive tab', 'paused chat', 'closed hours'])(
    'keeps callback acknowledgements behind the existing send gate: %s',
    async (gate) => {
      const h = await setup(undefined, true);
      if (gate === 'inactive tab') h.isActive.mockResolvedValue(false);
      if (gate === 'paused chat') await h.controller.setTakeover(context, true);
      if (gate === 'closed hours')
        await h.repository.update((settings) => ({
          ...settings,
          profiles: settings.profiles.map((profile) => ({
            ...profile,
            timezone: 'UTC',
            workingHours: {
              ...profile.workingHours,
              schedule: [
                {
                  day: (new Date().getUTCDay() + 1) % 7,
                  opens: '00:00',
                  closes: '00:01',
                },
              ],
            },
          })),
        }));
      await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
      if (gate !== 'paused chat') await delivery(h, 'BLOCKED');
      else
        expect(
          (await h.controller.handoffSnapshot(await h.repository.load()))
            .handoffs,
        ).toHaveLength(0);
      expect(h.send).not.toHaveBeenCalled();
    },
  );
  it('saves callbacks immediately, acknowledges without a provider call and survives worker recreation', async () => {
    const h = await setup(undefined, true);
    const message = { ...incoming(), text: 'Please call me' };
    await h.controller.handle(message, 1);
    await delivery(h, 'SENT');
    expect(h.requests).toHaveLength(0);
    const saved = await h.controller.handoffSnapshot(await h.repository.load());
    expect(saved.handoffs).toHaveLength(1);
    expect(saved.handoffs[0]).toMatchObject({
      reason: 'CALLBACK',
      status: 'OPEN',
      chatKey: context.chatKey,
      sourceEventKey: message.eventKey,
    });
    expect(saved.handoffs[0]?.question).toBeUndefined();
    expect(JSON.stringify(h.local.values)).not.toContain('Please call me');
    const restarted = new LiveController(
      h.repository,
      h.local,
      { send: h.send, isActive: h.isActive, notify: vi.fn() },
      h.backend,
    );
    expect(
      (await restarted.handoffSnapshot(await h.repository.load())).handoffs,
    ).toEqual(saved.handoffs);
    await restarted.handle({ type: 'ADAPTER_STATUS', version: 1, status }, 1);
    await restarted.handle(message, 1);
    expect(
      (await restarted.handoffSnapshot(await h.repository.load())).handoffs,
    ).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('persists unsupported questions before making a saved acknowledgement eligible to send', async () => {
    const h = await setup(undefined, true);
    h.output.needsHuman = true;
    const send = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tab, command) => {
      expect(
        (await h.controller.handoffSnapshot(await h.repository.load()))
          .handoffs,
      ).toHaveLength(1);
      return send(tab, command);
    });
    await h.controller.handle(incoming(), 1);
    await delivery(h, 'SENT');
    expect(h.send.mock.calls[0]?.[1]).toMatchObject({
      text: handoffAcknowledgement('en', true),
    });
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0]?.reason,
    ).toBe('UNRESOLVED');
  });
  it('records an unsafe provider callback promise even if the provider marks it resolved', async () => {
    const h = await setup(undefined, true);
    h.output.reply = 'Our team will reach you soon';
    await h.controller.handle(incoming(), 1);
    await delivery(h, 'SENT');
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load())).handoffs,
    ).toHaveLength(1);
    expect(h.send.mock.calls[0]?.[1]).toMatchObject({
      text: handoffAcknowledgement('en', true),
    });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(
      'Our team will reach you soon',
    );
  });
  it('sends a truthful manual-contact fallback when the follow-up write fails', async () => {
    const h = await setup(undefined, true);
    const write = h.local.set.bind(h.local);
    vi.spyOn(h.local, 'set').mockImplementation(async (values) => {
      if (HANDOFF_KEY in values) throw new Error('Disk unavailable');
      await write(values);
    });
    await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
    await delivery(h, 'SENT');
    expect(h.send.mock.calls[0]?.[1]).toMatchObject({
      text: handoffAcknowledgement('en', false),
    });
    expect(
      h.controller.snapshot(await h.repository.load()).live?.suggestion?.handoff
        ?.state,
    ).toBe('SAVE_FAILED');
    const view = await h.controller.handoffSnapshot(await h.repository.load());
    expect(view.handoffs).toHaveLength(0);
    expect(view.handoffError).toBe('HANDOFF_STORAGE_FAILED');
  });
  it('refuses a saved acknowledgement if its durable ticket disappears before final native authorization', async () => {
    const h = await setup(undefined, true);
    h.send.mockImplementation(async (tab, raw) => {
      const command = AutoSendCommandSchema.parse(raw);
      h.local.values[HANDOFF_KEY] = {};
      const result = await h.controller.handle(
        {
          type: 'ADAPTER_AUTHORIZE_SEND',
          version: 1,
          context: command.context,
          sourceEventKey: command.sourceEventKey,
          deliveryId: command.deliveryId,
          replyHash: await digest(command.text),
        },
        tab,
      );
      expect(result).toEqual({ ok: false });
      return { state: 'BLOCKED', reason: 'AUTHORIZATION_REVOKED' };
    });
    await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
    await delivery(h, 'BLOCKED');
  });
  it('retains opted-in questions and removes them when the profile revokes storage', async () => {
    const h = await setup(undefined, true);
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        privacy: { ...profile.privacy, storeRawMessages: true },
      })),
    }));
    const question = 'Please call me about my unresolved application';
    await h.controller.handle({ ...incoming(), text: question }, 1);
    await delivery(h, 'SENT');
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0]?.question,
    ).toBe(question);
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        privacy: { ...profile.privacy, storeRawMessages: false },
      })),
    }));
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0]?.question,
    ).toBeUndefined();
    expect(JSON.stringify(h.local.values)).not.toContain(question);
  });
  it('scrubs a question when privacy is revoked while the ticket write is pending and cancels the stale reply', async () => {
    const h = await setup(undefined, true);
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        privacy: { ...profile.privacy, storeRawMessages: true },
      })),
    }));
    const write = h.local.set.bind(h.local);
    let release = () => {};
    let entered = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.local, 'set').mockImplementation(async (values) => {
      if (HANDOFF_KEY in values && !entered) {
        entered = true;
        await blocked;
      }
      await write(values);
    });
    const question = 'Please call me about private details';
    const handling = h.controller.handle({ ...incoming(), text: question }, 1);
    await vi.waitFor(() => expect(entered).toBe(true));
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        privacy: { ...profile.privacy, storeRawMessages: false },
      })),
    }));
    release();
    await handling;
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0]?.question,
    ).toBeUndefined();
    expect(JSON.stringify(h.local.values)).not.toContain(question);
    expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps a callback note when a newer message replaces pending generation', async () => {
    let finish: (response: Response) => void = () => {};
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const h = await setup(delayed, true);
    await h.controller.handle(incoming(), 1);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    await h.controller.handle(
      { ...incoming('f'.repeat(64)), text: 'Please call me' },
      1,
    );
    await h.controller.handle(
      { ...incoming('d'.repeat(64)), text: 'Thanks' },
      1,
    );
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0],
    ).toMatchObject({ reason: 'CALLBACK', sourceEventKey: 'f'.repeat(64) });
    finish(
      Response.json({
        requestId: h.requests[0]?.requestId,
        reply: 'Old response',
        needsHuman: false,
        grounded: true,
        provider: 'openai',
        model: 'fixture-model',
      }),
    );
  });
  it('records unresolved provider failures without claiming a customer acknowledgement was sent', async () => {
    const h = await setup(undefined, true);
    vi.spyOn(h.backend, 'suggest').mockRejectedValue(
      new BackendFailure('PROVIDER_UNAVAILABLE'),
    );
    await h.controller.handle(incoming(), 1);
    await vi.waitFor(async () =>
      expect(
        h.controller.snapshot(await h.repository.load()).live?.suggestion
          ?.state,
      ).toBe('ERROR'),
    );
    await vi.waitFor(async () =>
      expect(
        (await h.controller.handoffSnapshot(await h.repository.load()))
          .handoffs,
      ).toHaveLength(1),
    );
    expect(
      h.controller.snapshot(await h.repository.load()).live?.suggestion?.state,
    ).toBe('ERROR');
    expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps a newer pending reply while an older provider-failure ticket is being saved', async () => {
    const h = await setup(undefined, true);
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        behavior: { ...profile.behavior, perChatCooldownSeconds: 0 },
      })),
    }));
    vi.spyOn(h.backend, 'suggest').mockRejectedValueOnce(
      new BackendFailure('PROVIDER_UNAVAILABLE'),
    );
    const write = h.local.set.bind(h.local);
    let entered = false;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.local, 'set').mockImplementation(async (values) => {
      if (HANDOFF_KEY in values && !entered) {
        entered = true;
        await blocked;
      }
      await write(values);
    });
    await h.controller.handle(incoming(), 1);
    await vi.waitFor(() => expect(entered).toBe(true));
    await h.controller.handle(
      { ...incoming('f'.repeat(64)), text: 'A newer question' },
      1,
    );
    release();
    await delivery(h, 'SENT');
    expect(h.requests.map((item) => item.text)).toEqual(['A newer question']);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0]?.sourceEventKey,
    ).toBe('e'.repeat(64));
  });
});

describe('business-authored saved follow-up replies', () => {
  const custom = 'Our team will reach out to you soon.';
  async function configured(confirmed = true, text = custom) {
    const h = await setup(undefined, true);
    await h.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        followupReply: text,
        followupCommitmentConfirmed: confirmed,
      })),
    }));
    return h;
  }
  it('sends the exact committed custom reply only after its callback is durably saved', async () => {
    const h = await configured();
    const send = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tab, command) => {
      expect(
        (await h.controller.handoffSnapshot(await h.repository.load()))
          .handoffs[0],
      ).toMatchObject({ reason: 'CALLBACK', sourceEventKey: 'e'.repeat(64) });
      return send(tab, command);
    });
    await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
    await delivery(h, 'SENT');
    expect(h.requests).toHaveLength(0);
    expect(h.send.mock.calls[0]?.[1]).toMatchObject({ text: custom });
  });
  it('uses the committed reply for unresolved work and keeps worker-only fields off the generation API', async () => {
    const h = await configured();
    h.output.needsHuman = true;
    await h.controller.handle(incoming(), 1);
    await delivery(h, 'SENT');
    expect(h.send.mock.calls[0]?.[1]).toMatchObject({ text: custom });
    expect(
      (await h.controller.handoffSnapshot(await h.repository.load()))
        .handoffs[0]?.reason,
    ).toBe('UNRESOLVED');
    expect(JSON.stringify(h.synced)).not.toContain('followupReply');
    expect(JSON.stringify(h.synced)).not.toContain(
      'followupCommitmentConfirmed',
    );
    expect(JSON.stringify(h.synced)).not.toContain(custom);
  });
  it.each([
    { confirmed: false, text: custom },
    { confirmed: true, text: '' },
    { confirmed: true, text: 'Our team was already notified.' },
  ])(
    'uses the fixed saved acknowledgement for inactive or invalid custom text: $text',
    async ({ confirmed, text }) => {
      const h = await configured(confirmed, text);
      await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
      await delivery(h, 'SENT');
      expect(h.send.mock.calls[0]?.[1]).toMatchObject({
        text: handoffAcknowledgement('en', true),
      });
    },
  );
  it('never uses a custom success promise when saving the handoff cannot be confirmed', async () => {
    const h = await configured();
    const write = h.local.set.bind(h.local);
    vi.spyOn(h.local, 'set').mockImplementation(async (values) => {
      if (HANDOFF_KEY in values) throw new Error('Write unavailable');
      return write(values);
    });
    await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
    await delivery(h, 'SENT');
    expect(h.send.mock.calls[0]?.[1]).toMatchObject({
      text: handoffAcknowledgement('en', false),
    });
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(custom);
  });
  it('revokes a custom acknowledgement if the business commitment changes during send authorization', async () => {
    const h = await configured();
    h.send.mockImplementation(async (tab, raw) => {
      const command = AutoSendCommandSchema.parse(raw);
      await h.repository.update((settings) => ({
        ...settings,
        profiles: settings.profiles.map((profile) => ({
          ...profile,
          followupCommitmentConfirmed: false,
        })),
      }));
      expect(
        await h.controller.handle(
          {
            type: 'ADAPTER_AUTHORIZE_SEND',
            version: 1,
            context: command.context,
            sourceEventKey: command.sourceEventKey,
            deliveryId: command.deliveryId,
            replyHash: await digest(command.text),
          },
          tab,
        ),
      ).toEqual({ ok: false });
      return { state: 'BLOCKED', reason: 'AUTHORIZATION_REVOKED' };
    });
    await h.controller.handle({ ...incoming(), text: 'Please call me' }, 1);
    await delivery(h, 'BLOCKED');
  });
});

describe('opt-in web automatic replies', () => {
  it('persists a follow-up before automatically acknowledging an unresolved question', async () => {
    const harness = await setup(undefined, true);
    harness.output.needsHuman = true;
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'SENT');
    const suggestion = harness.controller.snapshot(
      await harness.repository.load(),
    ).live?.suggestion;
    expect(suggestion).toMatchObject({
      needsHuman: true,
      handoff: { state: 'SAVED', reason: 'UNRESOLVED' },
      reply: handoffAcknowledgement('en', true),
    });
    expect(harness.send.mock.calls[0]?.[1]).toMatchObject({
      text: handoffAcknowledgement('en', true),
    });
    expect(harness.send.mock.calls[0]?.[1]).not.toMatchObject({
      text: 'A verified fixture reply.',
    });
  });
  it('keeps manual generation as a draft even for an unsupported question in Auto-reply mode', async () => {
    const harness = await setup(undefined, true);
    harness.output.needsHuman = true;
    await harness.controller.setTakeover(context, true);
    await harness.controller.handle(incoming(), 1);
    await harness.controller.retry();
    await vi.waitFor(async () =>
      expect(
        harness.controller.snapshot(await harness.repository.load()).live
          ?.suggestion?.state,
      ).toBe('READY'),
    );
    expect(harness.send).not.toHaveBeenCalled();
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.standardFallback,
    ).not.toBe(true);
  });
  it('queues the latest message instead of losing both replies during cooldown', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const harness = await setup(delayed, true);
    await harness.controller.handle(
      { ...incoming(), text: 'First question' },
      1,
    );
    await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
    await harness.controller.handle(
      { ...incoming('f'.repeat(64)), text: 'Latest question' },
      1,
    );
    expect(
      harness.controller.snapshot(await harness.repository.load()).live
        ?.suggestion?.state,
    ).toBe('WAITING');
    finish(
      Response.json({
        requestId: harness.requests[0]?.requestId,
        reply: 'Obsolete answer',
        needsHuman: false,
        grounded: true,
        provider: 'openai',
        model: 'fixture-model',
      }),
    );
    now.mockReturnValue(1800000010001);
    await harness.controller.handle(
      { type: 'ADAPTER_POLL', version: 1, context },
      1,
    );
    await delivery(harness, 'SENT');
    expect(harness.requests.map((request) => request.text)).toEqual([
      'First question',
      'Latest question',
    ]);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.send.mock.calls[0]?.[1]).toMatchObject({
      sourceEventKey: 'f'.repeat(64),
      text: 'A verified fixture reply.',
    });
  });
  it('sends a fresh eligible reply once, retaining only hashes and projecting backend draft policy', async () => {
    const harness = await setup(undefined, true);
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'SENT');
    await harness.controller.handle(incoming(), 1);
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(harness.synced).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profile: expect.objectContaining({ replyMode: 'DRAFT_ONLY' }),
        }),
      ]),
    );
    expect(JSON.stringify(harness.synced)).not.toContain('webAutoSendOptIn');
    const persisted = JSON.stringify(harness.local.values);
    expect(persisted).toContain('SENT');
    expect(persisted).not.toContain('A fresh question');
    expect(persisted).not.toContain('A verified fixture reply.');
  });
  it('never sends in Draft only mode', async () => {
    const harness = await setup();
    await harness.controller.handle(incoming(), 1);
    await vi.waitFor(async () =>
      expect(
        harness.controller.snapshot(await harness.repository.load()).live
          ?.suggestion?.state,
      ).toBe('READY'),
    );
    expect(harness.send).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'outside-hours'] as const)(
    'keeps a draft when %s blocks sending',
    async (reason) => {
      const harness = await setup(undefined, true);
      if (reason === 'inactive') harness.isActive.mockResolvedValue(false);
      if (reason === 'outside-hours')
        await harness.repository.update((settings) => ({
          ...settings,
          profiles: settings.profiles.map((profile) => ({
            ...profile,
            workingHours: {
              description: 'Closed',
              outsideHoursAction: 'DRAFT',
              schedule: [{ day: 0, opens: '00:00', closes: '00:00' }],
            },
          })),
        }));
      await harness.controller.handle(incoming(), 1);
      await delivery(harness, 'BLOCKED');
      expect(harness.send).not.toHaveBeenCalled();
    },
  );
  it('persists chat takeover, blocks generation until explicit release, and keeps manual generation draft-only', async () => {
    const harness = await setup(undefined, true);
    await harness.controller.setTakeover(context, true);
    await harness.controller.handle(incoming(), 1);
    expect(
      harness.calls.filter((url) => url.endsWith('/api/assist')),
    ).toHaveLength(0);
    expect(
      (await harness.repository.load()).takeovers[context.chatKey]?.profileId,
    ).toBe(context.profileId);
    const restarted = new LiveController(
      harness.repository,
      harness.local,
      { send: harness.send, isActive: harness.isActive, notify: vi.fn() },
      harness.backend,
    );
    await restarted.handle({ type: 'ADAPTER_STATUS', version: 1, status }, 1);
    await restarted.handle(incoming('d'.repeat(64)), 1);
    expect(
      harness.calls.filter((url) => url.endsWith('/api/assist')),
    ).toHaveLength(0);
    await expect(
      harness.controller.setTakeover(
        { ...context, profileId: 'other-business' },
        false,
      ),
    ).rejects.toThrow('STALE_DRAFT');
    await harness.controller.retry();
    await vi.waitFor(async () =>
      expect(
        harness.controller.snapshot(await harness.repository.load()).live
          ?.suggestion?.state,
      ).toBe('READY'),
    );
    expect(harness.send).not.toHaveBeenCalled();
    await harness.controller.setTakeover(context, false);
    expect(
      (await harness.repository.load()).takeovers[context.chatKey],
    ).toBeUndefined();
    await harness.controller.handle(incoming('f'.repeat(64)), 1);
    await delivery(harness, 'SENT');
  });
  it('denies content-script requests without a matching worker-owned pending send, tab, hash and scope', async () => {
    const harness = await setup(undefined, true);
    const command = {
      type: 'ADAPTER_AUTHORIZE_SEND',
      version: 1,
      context,
      sourceEventKey: 'e'.repeat(64),
      deliveryId: crypto.randomUUID(),
      replyHash: 'f'.repeat(64),
    } as const;
    expect(await harness.controller.handle(command, 1)).toEqual({ ok: false });
    harness.send.mockImplementation(async (tabId, raw) => {
      const parsed = AutoSendCommandSchema.parse(raw);
      const request = {
        ...command,
        context: parsed.context,
        sourceEventKey: parsed.sourceEventKey,
        deliveryId: parsed.deliveryId,
        replyHash: await digest(parsed.text),
      };
      expect(await harness.controller.handle(request, tabId + 1)).toEqual({
        ok: false,
      });
      expect(
        await harness.controller.handle(
          { ...request, replyHash: '0'.repeat(64) },
          tabId,
        ),
      ).toEqual({ ok: false });
      expect(
        await harness.controller.handle(
          { ...request, context: { ...context, profileId: 'wrong-profile' } },
          tabId,
        ),
      ).toEqual({ ok: false });
      await harness.controller.setTakeover(context, true);
      expect(await harness.controller.handle(request, tabId)).toEqual({
        ok: false,
      });
      return { state: 'BLOCKED', reason: 'AUTHORIZATION_REVOKED' };
    });
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'BLOCKED');
  });
  it('will not send if durable reservation fails', async () => {
    const harness = await setup(undefined, true);
    const original = harness.local.set.bind(harness.local);
    vi.spyOn(harness.local, 'set').mockImplementation(async (values) => {
      if (DELIVERY_KEY in values) throw new Error('Storage unavailable');
      await original(values);
    });
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'BLOCKED');
    expect(harness.send).not.toHaveBeenCalled();
  });
  it('rechecks a pause saved while the final active-tab query is pending', async () => {
    const harness = await setup(undefined, true);
    let authorized: unknown;
    harness.send.mockImplementation(async (tabId, raw) => {
      const command = AutoSendCommandSchema.parse(raw);
      let entered = false;
      let release: (active: boolean) => void = () => undefined;
      const active = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      harness.isActive.mockImplementationOnce(() => {
        entered = true;
        return active;
      });
      const checking = harness.controller.handle(
        {
          type: 'ADAPTER_AUTHORIZE_SEND',
          version: 1,
          context: command.context,
          deliveryId: command.deliveryId,
          sourceEventKey: command.sourceEventKey,
          replyHash: await digest(command.text),
        },
        tabId,
      );
      await vi.waitFor(() => expect(entered).toBe(true));
      await harness.controller.setTakeover(context, true);
      release(true);
      authorized = await checking;
      return { state: 'BLOCKED', reason: 'AUTHORIZATION_REVOKED' };
    });
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'BLOCKED');
    expect(authorized).toEqual({ ok: false });
  });
  it('never replays an uncertain delivery after restart or a manual retry', async () => {
    const harness = await setup(undefined, true);
    harness.send.mockRejectedValue(new Error('Acknowledgement lost'));
    await harness.controller.handle(incoming(), 1);
    await delivery(harness, 'UNCERTAIN');
    await expect(harness.controller.retry()).rejects.toThrow('STALE_DRAFT');
    const restarted = new LiveController(
      harness.repository,
      harness.local,
      { send: harness.send, isActive: harness.isActive, notify: vi.fn() },
      harness.backend,
    );
    await restarted.handle({ type: 'ADAPTER_STATUS', version: 1, status }, 1);
    await restarted.handle(incoming(), 1);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });
  it('drops automatic sending when settings change during generation', async () => {
    let finish: (response: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const harness = await setup(response, true);
    await harness.controller.handle(incoming(), 1);
    await vi.waitFor(() =>
      expect(harness.calls.some((url) => url.endsWith('/api/assist'))).toBe(
        true,
      ),
    );
    const id = harness.controller.snapshot(await harness.repository.load()).live
      ?.suggestion?.id;
    await harness.repository.update((settings) => ({
      ...settings,
      enabled: false,
    }));
    finish(
      Response.json({
        requestId: id,
        reply: 'A verified fixture reply.',
        needsHuman: false,
        grounded: true,
        provider: 'openai',
        model: 'fixture-model',
      }),
    );
    await vi.waitFor(async () =>
      expect(
        harness.controller.snapshot(await harness.repository.load()).live
          ?.suggestion?.state,
      ).toBe('ERROR'),
    );
    expect(harness.send).not.toHaveBeenCalled();
  });
});
describe('live message ownership and stale result handling', () => {
  it('exposes missing-selector diagnostics even before chat identity exists', async () => {
    const { controller, repository } = await setup();
    const waiting = {
      ...status,
      ready: false,
      context: null,
      matches: { ...status.matches, messageList: -1 },
    };
    await controller.handle(
      { type: 'ADAPTER_STATUS', version: 1, status: waiting },
      1,
    );
    controller.selectTab(1);
    const state = controller.snapshot(await repository.load());
    expect(state.live?.status).toEqual(waiting);
    expect(state.live?.message).toBeNull();
    expect(state.live?.suggestion).toBeNull();
  });
  it('keeps a pending reply through diagnostics-only updates in the same chat', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const { controller, repository, calls } = await setup(delayed);
    await controller.handle(
      {
        type: 'ADAPTER_MESSAGE',
        version: 1,
        context,
        eventKey: 'd'.repeat(64),
        text: 'A new message',
      },
      1,
    );
    await vi.waitFor(() =>
      expect(calls.some((url) => url.endsWith('/api/assist'))).toBe(true),
    );
    const id = controller.snapshot(await repository.load()).live?.suggestion
      ?.id;
    await controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: {
          ...status,
          matches: { ...status.matches, outgoingMessage: 0 },
        },
      },
      1,
    );
    finish(
      Response.json({
        requestId: id,
        reply: 'Confirmed reply',
        needsHuman: false,
        grounded: true,
        provider: 'openai',
        model: 'fixture-model',
      }),
    );
    await vi.waitFor(async () =>
      expect(
        controller.snapshot(await repository.load()).live?.suggestion?.state,
      ).toBe('READY'),
    );
  });
  it('generates a scoped suggestion without putting customer text into storage', async () => {
    const { controller, repository, local } = await setup();
    await controller.handle(
      {
        type: 'ADAPTER_MESSAGE',
        version: 1,
        context,
        eventKey: 'b'.repeat(64),
        text: 'private-customer-text',
      },
      1,
    );
    await vi.waitFor(async () =>
      expect(
        controller.snapshot(await repository.load()).live?.suggestion?.state,
      ).toBe('READY'),
    );
    expect(JSON.stringify(local.values)).not.toContain('private-customer-text');
    expect(JSON.stringify(local.values)).not.toContain(
      'A verified fixture reply.',
    );
  });
  it('deduplicates across worker/controller recreation', async () => {
    const { controller, repository, local, calls } = await setup();
    const input = {
      type: 'ADAPTER_MESSAGE',
      version: 1,
      context,
      eventKey: 'b'.repeat(64),
      text: 'private',
    } as const;
    await controller.handle(input, 1);
    await vi.waitFor(() =>
      expect(calls.some((url) => url.endsWith('/api/assist'))).toBe(true),
    );
    const restarted = new LiveController(
      repository,
      local,
      { send: vi.fn(), notify: vi.fn() },
      new BackendClient(vi.fn()),
    );
    await restarted.handle({ type: 'ADAPTER_STATUS', version: 1, status }, 1);
    await restarted.handle(input, 1);
    expect(
      restarted.snapshot(await repository.load()).live?.message,
    ).toBeNull();
  });
  it('drops a late response after a chat change', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const { controller, calls, repository } = await setup(delayed);
    await controller.handle(
      {
        type: 'ADAPTER_MESSAGE',
        version: 1,
        context,
        eventKey: 'b'.repeat(64),
        text: 'private',
      },
      1,
    );
    await vi.waitFor(() =>
      expect(calls.some((url) => url.endsWith('/api/assist'))).toBe(true),
    );
    await controller.handle(
      {
        type: 'ADAPTER_STATUS',
        version: 1,
        status: {
          ...status,
          context: {
            ...context,
            contextId: 'new-chat',
            chatKey: 'c'.repeat(64),
          },
        },
      },
      1,
    );
    finish(
      Response.json({
        requestId: 'stale',
        reply: 'Wrong chat reply',
        needsHuman: false,
        grounded: true,
        provider: 'openai',
        model: 'fixture-model',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      controller.snapshot(await repository.load()).live?.suggestion,
    ).toBeNull();
  });
  it('blocks disabled profiles and stale draft insertion', async () => {
    const { controller, repository, calls, send } = await setup();
    await repository.update((settings) => ({ ...settings, enabled: false }));
    await controller.handle(
      {
        type: 'ADAPTER_MESSAGE',
        version: 1,
        context,
        eventKey: 'b'.repeat(64),
        text: 'private',
      },
      1,
    );
    expect(calls.filter((url) => url.endsWith('/api/assist'))).toHaveLength(0);
    await expect(controller.insert('wrong-draft', 'No')).rejects.toThrow(
      'STALE_DRAFT',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('stores opt-in separately and disconnects without keeping raw messages', async () => {
    const { controller, repository } = await setup();
    await controller.disconnect();
    const settings = await repository.load();
    expect(settings.connections[settings.activeProfileId]).toEqual({
      token: '',
      autoSuggest: false,
    });
    expect(controller.snapshot(settings).live).toBeNull();
  });
});
