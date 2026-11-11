import { z } from 'zod';
import {
  AdapterConfigSchema,
  AutoSendResultSchema,
} from '@assistant/contracts';
import type {
  AdapterRequest,
  LiveState,
  ProviderStatus,
  AdapterContext,
  AutoSendResult,
  BusinessProfile,
  HandoffStatus,
  HandoffReason,
  UnreadOpenResult,
} from '@assistant/contracts';
import type {
  StorageArea,
  SettingsRepository,
} from '../storage/settings-repository.js';
import type { Settings } from '../messaging/contracts.js';
import { BackendClient, BackendFailure } from './backend-client.js';
import { DeliveryJournal, digest } from './delivery-journal.js';
import { HandoffInbox, HandoffFailure } from './handoff-inbox.js';
import {
  permitsDraftNow,
  safeFallback,
  detectLanguage,
  detectCallbackRequest,
  detectHandoffPromise,
  handoffAcknowledgement,
  savedFollowupReply,
} from '@assistant/core';

export interface LiveTransport {
  send(tabId: number, message: unknown): Promise<unknown>;
  notify(): void;
  reconnect?(): Promise<void>;
  isActive?(tabId: number): Promise<boolean>;
  isBackground?(tabId: number): Promise<boolean>;
}
export class LiveFailure extends Error {
  constructor(
    readonly code:
      | 'BACKEND_ERROR'
      | 'STALE_DRAFT'
      | 'COMPOSER_BUSY'
      | 'WHATSAPP_UNAVAILABLE',
  ) {
    super(code);
  }
}
const dedupSchema = z.record(
  z.string().regex(/^[a-f0-9]{64}$/),
  z.number().nonnegative(),
);
interface PendingAutomatic {
  state: LiveState;
  context: AdapterContext;
  revision: number;
  eventKey: string;
  suggestionId: string;
}
type BackendMetadata = ProviderStatus & { paired: boolean; error: string };
const chatScope = (context: AdapterContext) =>
  `${context.profileId}:${context.chatKey}`;
type UnreadRequest = Extract<AdapterRequest, { type: 'ADAPTER_OPEN_UNREAD' }>;
function handoffReply(profile: BusinessProfile, text: string, saved: boolean) {
  const language = detectLanguage(text, profile);
  return saved
    ? savedFollowupReply(profile, language)
    : handoffAcknowledgement(language, false);
}
function insideReplyHours(profile: BusinessProfile) {
  return permitsDraftNow({
    ...profile,
    workingHours: { ...profile.workingHours, outsideHoursAction: 'NO_REPLY' },
  });
}
export class LiveController {
  private readonly unreadGrants = new Map<
    number,
    {
      id: string;
      revision: number;
      request: UnreadRequest;
    }
  >();
  private readonly tabs = new Map<number, LiveState>();
  private readonly metadata = new Map<string, BackendMetadata>();
  private readonly backendStatusChecks = new Map<
    string,
    { revision: number; promise: Promise<void> }
  >();
  private readonly hydratedMetadata = new Map<
    string,
    {
      revision: number;
      value: BackendMetadata;
      retryAt: number;
    }
  >();
  private readonly cooldowns = new Map<string, number>();
  private readonly pendingAutomatic = new Map<number, PendingAutomatic>();
  private readonly automaticRuns = new Map<string, symbol>();
  private queue: Promise<unknown> = Promise.resolve();
  private selectedTab: number | null = null;
  private readonly journal: DeliveryJournal;
  private readonly handoffs: HandoffInbox;
  private readonly handoffErrors = new Map<string, string>();
  private readonly deliveries = new Map<
    string,
    {
      tabId: number;
      context: AdapterContext;
      eventKey: string;
      suggestionId: string;
      replyHash: string;
      revision: number;
    }
  >();
  constructor(
    private readonly repository: SettingsRepository,
    private readonly local: StorageArea,
    private readonly transport: LiveTransport,
    private readonly backend = new BackendClient(),
  ) {
    this.journal = new DeliveryJournal(local);
    this.handoffs = new HandoffInbox(local);
  }
  async handoffSnapshot(settings: Settings) {
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    if (!profile) return { handoffs: [], handoffError: 'PROFILE_CHANGED' };
    try {
      return {
        handoffs: await this.handoffs.list(profile),
        handoffError: this.handoffErrors.get(profile.id) ?? '',
      };
    } catch {
      return { handoffs: [], handoffError: 'HANDOFF_STORAGE_FAILED' };
    }
  }
  async updateHandoff(profileId: string, id: string, status: HandoffStatus) {
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    if (!profile || profile.id !== profileId)
      throw new LiveFailure('STALE_DRAFT');
    await this.handoffs.setStatus(profile, id, status);
    this.transport.notify();
  }
  private async saveHandoff(
    profile: BusinessProfile,
    context: AdapterContext,
    message: NonNullable<LiveState['message']>,
    reason: HandoffReason,
    expectedRevision: number,
  ): Promise<NonNullable<NonNullable<LiveState['suggestion']>['handoff']>> {
    try {
      const current = await this.repository.load();
      const owner = current.profiles.find((item) => item.id === profile.id);
      if (
        !owner ||
        context.profileId !== profile.id ||
        current.activeProfileId !== profile.id ||
        current.revision !== expectedRevision ||
        !current.enabled
      )
        return { state: 'SAVE_FAILED', reason };
      const result = await this.handoffs.create(owner, {
        chatKey: context.chatKey,
        sourceEventKey: message.eventKey,
        chatLabel: context.chatLabel || 'WhatsApp chat',
        reason,
        ...(owner.privacy.storeRawMessages ? { question: message.text } : {}),
      });
      // A privacy edit may finish while local storage is writing. Scrub any
      // newly disallowed question before exposing a saved acknowledgement.
      const latest = (await this.repository.load()).profiles.find(
        (item) => item.id === profile.id,
      );
      if (
        latest &&
        (!latest.privacy.storeRawMessages ||
          latest.privacy.logRetentionDays < owner.privacy.logRetentionDays)
      )
        await this.handoffs.list(latest);
      this.handoffErrors.delete(profile.id);
      return { state: 'SAVED', reason, id: result.record.id };
    } catch (error) {
      this.handoffErrors.set(
        profile.id,
        error instanceof HandoffFailure ? error.code : 'HANDOFF_STORAGE_FAILED',
      );
      return { state: 'SAVE_FAILED', reason };
    } finally {
      this.transport.notify();
    }
  }
  async rehydrateBackendStatus(settings: Settings): Promise<void> {
    const profileId = settings.activeProfileId;
    const token = settings.connections[profileId]?.token;
    if (!token) return;
    const previous = this.metadata.get(profileId);
    const cached = this.hydratedMetadata.get(profileId);
    // A generation/connect result is more specific than a status probe. In
    // particular a healthy local status must not erase a model request error.
    if (previous && cached?.value !== previous) return;
    if (previous && cached?.revision === settings.revision) {
      const transient =
        previous.error === 'BACKEND_OFFLINE' ||
        previous.error === 'PROVIDER_UNAVAILABLE';
      if (!transient || Date.now() < cached.retryAt) return;
    }
    const running = this.backendStatusChecks.get(profileId);
    if (running?.revision === settings.revision) return running.promise;
    const check = { revision: settings.revision, promise: Promise.resolve() };
    check.promise = (async () => {
      let value: BackendMetadata;
      try {
        const status = await this.backend.status(token, 2000);
        value = {
          ...status,
          paired: true,
          error: status.configured ? '' : 'NOT_CONFIGURED',
        };
      } catch (error) {
        const code =
          error instanceof BackendFailure &&
          ['BACKEND_OFFLINE', 'UNAUTHORIZED', 'NOT_CONFIGURED'].includes(
            error.message,
          )
            ? error.message
            : 'PROVIDER_UNAVAILABLE';
        value = {
          configured: false,
          provider: null,
          model: '',
          paired: true,
          error: code,
        };
      }
      const current = await this.repository.load();
      if (
        current.activeProfileId !== profileId ||
        current.revision !== settings.revision ||
        current.connections[profileId]?.token !== token ||
        this.metadata.get(profileId) !== previous ||
        this.backendStatusChecks.get(profileId) !== check
      )
        return;
      this.metadata.set(profileId, value);
      this.hydratedMetadata.set(profileId, {
        revision: settings.revision,
        value,
        retryAt: Date.now() + 15000,
      });
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.backendStatusChecks.get(profileId) === check)
          this.backendStatusChecks.delete(profileId);
      });
    this.backendStatusChecks.set(profileId, check);
    await check.promise;
  }
  snapshot(settings: Settings) {
    const selected =
      this.selectedTab === null ? undefined : this.tabs.get(this.selectedTab);
    const live =
      selected &&
      (selected.status.context === null ||
        selected.status.context.profileId === settings.activeProfileId)
        ? selected
        : ([...this.tabs.values()]
            .reverse()
            .find(
              (entry) =>
                entry.status.context === null ||
                entry.status.context.profileId === settings.activeProfileId,
            ) ?? null);
    return {
      live,
      backend: this.metadata.get(settings.activeProfileId) ?? {
        configured: false,
        provider: null,
        model: '',
        paired: Boolean(settings.connections[settings.activeProfileId]?.token),
        error: '',
      },
    };
  }
  forget(tabId: number) {
    this.unreadGrants.delete(tabId);
    this.cancelAutomatic(tabId);
    this.tabs.delete(tabId);
    this.transport.notify();
  }
  selectTab(tabId: number) {
    if (this.tabs.has(tabId)) {
      this.selectedTab = tabId;
      this.transport.notify();
    }
  }
  async bootstrap() {
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    if (!profile) throw new Error('Missing profile');
    const saved = await this.local.get('assistant.hashSalt.v1');
    const salt =
      typeof saved['assistant.hashSalt.v1'] === 'string'
        ? saved['assistant.hashSalt.v1']
        : crypto.randomUUID();
    if (!saved['assistant.hashSalt.v1'])
      await this.local.set({ 'assistant.hashSalt.v1': salt });
    return AdapterConfigSchema.parse({
      profileId: profile.id,
      enabled: settings.enabled && profile.replyMode !== 'OFF',
      autoSendEnabled:
        settings.enabled &&
        profile.replyMode === 'AUTO_REPLY_WEB' &&
        profile.webAutoSendOptIn,
      backgroundReplies:
        settings.enabled &&
        profile.replyMode === 'AUTO_REPLY_WEB' &&
        profile.webAutoSendOptIn &&
        profile.backgroundReplies,
      autoOpenUnread:
        settings.enabled &&
        profile.replyMode === 'AUTO_REPLY_WEB' &&
        profile.webAutoSendOptIn &&
        profile.autoOpenUnread,
      includeExistingUnread:
        settings.enabled &&
        profile.replyMode === 'AUTO_REPLY_WEB' &&
        profile.webAutoSendOptIn &&
        profile.autoOpenUnread &&
        profile.includeExistingUnread,
      salt,
      selectors: settings.selectors,
      duplicateWindowSeconds: profile.behavior.duplicateWindowSeconds,
    });
  }
  handle(request: AdapterRequest, tabId: number) {
    const result = this.queue.then(() => this.process(request, tabId));
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async automaticTabAllowed(tabId: number, profile: BusinessProfile) {
    // Background mode has exactly one owner, including when that tab is visible.
    // This prevents a second observer from consuming the shared deduplication key.
    if (profile.backgroundReplies)
      return Boolean(await this.transport.isBackground?.(tabId));
    return Boolean(await this.transport.isActive?.(tabId));
  }
  private async openUnread(
    request: UnreadRequest,
    tabId: number,
  ): Promise<UnreadOpenResult> {
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    const token = settings.connections[request.profileId]?.token;
    const state = this.tabs.get(tabId);
    const from = state?.status.context;
    const now = Date.now();
    if (
      !profile ||
      !settings.enabled ||
      profile.id !== request.profileId ||
      profile.replyMode !== 'AUTO_REPLY_WEB' ||
      !profile.webAutoSendOptIn ||
      !profile.autoOpenUnread ||
      (request.existingUnread && !profile.includeExistingUnread)
    )
      return { state: 'SKIP', reason: 'POLICY_DISABLED' };
    if (!token) return { state: 'SKIP', reason: 'BACKEND_NOT_CONFIGURED' };
    if (!insideReplyHours(profile))
      return { state: 'SKIP', reason: 'OUTSIDE_HOURS' };
    if (
      request.observedAt > now ||
      now - request.observedAt >=
        Math.min(profile.behavior.duplicateWindowSeconds, 300) * 1000
    )
      return { state: 'SKIP', reason: 'SOURCE_EXPIRED' };
    if (
      !state ||
      (from?.contextId ?? null) !== request.fromContextId ||
      (from &&
        (from.profileId !== profile.id ||
          from.chatKey === request.targetKey ||
          from.titleKey === request.titleKey))
    )
      return { state: 'SKIP', reason: 'SOURCE_CHANGED' };
    if (from && settings.takeovers[from.chatKey]?.profileId === profile.id)
      return { state: 'SKIP', reason: 'SOURCE_PAUSED' };
    const pauses = Object.values(settings.takeovers).filter(
      (pause) => pause.profileId === profile.id,
    );
    if (
      pauses.some(
        (pause) =>
          pause.chatKey === request.targetKey ||
          pause.chatKey === request.titleKey ||
          pause.titleKey === request.titleKey,
      )
    )
      return { state: 'SKIP', reason: 'TARGET_PAUSED' };
    // An old pause without a title alias cannot safely be ruled out for a title-only row.
    if (!request.targetKey && pauses.some((pause) => !pause.titleKey))
      return { state: 'SKIP', reason: 'PAUSE_IDENTITY_UNKNOWN' };
    if (
      (from && !state.status.ready) ||
      this.pendingAutomatic.has(tabId) ||
      (from && this.automaticRuns.has(chatScope(from))) ||
      state.suggestion?.state === 'GENERATING' ||
      state.suggestion?.delivery?.state === 'SENDING'
    )
      return { state: 'WAIT' };
    // Opening a row marks it read. Check the connection before allowing the click.
    try {
      if (!(await this.backend.status(token, 2000)).configured)
        return { state: 'SKIP', reason: 'BACKEND_NOT_CONFIGURED' };
    } catch (error) {
      // A local backend may start after Chrome. Keep the still-unopened row
      // briefly; the adapter bounds this wait and revalidates its badge.
      if (
        error instanceof BackendFailure &&
        error.message === 'BACKEND_OFFLINE'
      )
        return { state: 'WAIT', reason: 'BACKEND_OFFLINE' };
      return { state: 'SKIP', reason: 'BACKEND_REJECTED' };
    }
    const allowedTab = await this.automaticTabAllowed(tabId, profile);
    const current = await this.repository.load();
    if (this.tabs.get(tabId) !== state)
      return { state: 'SKIP', reason: 'SOURCE_CHANGED' };
    if (!allowedTab) return { state: 'SKIP', reason: 'TAB_NOT_ELIGIBLE' };
    // Connecting with the already-saved pairing can advance revision while
    // health is in flight. Keep the unopened candidate for a bounded recheck;
    // this attempt grants nothing and the next attempt reruns every gate.
    if (current.revision !== settings.revision)
      return { state: 'WAIT', reason: 'POLICY_CHANGED' };
    const id = crypto.randomUUID();
    this.unreadGrants.set(tabId, { id, revision: settings.revision, request });
    return { state: 'OPEN', grantId: id };
  }
  private async process(
    request: AdapterRequest,
    tabId: number,
  ): Promise<unknown> {
    if (request.type === 'ADAPTER_BOOTSTRAP') return this.bootstrap();
    if (request.type === 'ADAPTER_OPEN_UNREAD')
      return this.openUnread(request, tabId);
    if (request.type === 'ADAPTER_POLL') {
      const pending = this.pendingAutomatic.get(tabId);
      if (
        !pending ||
        pending.context.profileId !== request.context.profileId ||
        pending.context.chatKey !== request.context.chatKey ||
        pending.context.contextId !== request.context.contextId
      )
        return { ok: false };
      await this.flushAutomatic(tabId);
      return this.automaticAck(tabId);
    }
    if (request.type === 'ADAPTER_AUTHORIZE_SEND') {
      const pending = this.deliveries.get(request.deliveryId);
      if (
        !pending ||
        pending.tabId !== tabId ||
        pending.replyHash !== request.replyHash ||
        pending.eventKey !== request.sourceEventKey ||
        pending.context.profileId !== request.context.profileId ||
        pending.context.chatKey !== request.context.chatKey ||
        pending.context.contextId !== request.context.contextId
      )
        return { ok: false };
      return { ok: await this.canSend(pending) };
    }
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    if (!profile) return { ok: false };
    if (
      request.type === 'ADAPTER_MESSAGE' &&
      (request.unreadGrantId ||
        (profile.replyMode === 'AUTO_REPLY_WEB' && profile.backgroundReplies))
    ) {
      if (
        !(await this.automaticTabAllowed(tabId, profile)) ||
        (await this.repository.load()).revision !== settings.revision
      )
        return { ok: false };
    }
    if (request.type === 'ADAPTER_STATUS') {
      if (
        request.status.context &&
        request.status.context.profileId !== profile.id
      )
        return { ok: false };
      const previous = this.tabs.get(tabId);
      const same =
        previous?.status.context?.contextId ===
          request.status.context?.contextId &&
        previous?.status.context?.chatKey === request.status.context?.chatKey;
      if (!same || !request.status.ready) this.cancelAutomatic(tabId);
      if (this.tabs.size >= 32 && !previous)
        this.forget(this.tabs.keys().next().value ?? -1);
      if (same && previous) previous.status = request.status;
      this.tabs.set(
        tabId,
        same && previous
          ? previous
          : {
              tabId,
              status: request.status,
              message: same ? (previous?.message ?? null) : null,
              suggestion: same ? (previous?.suggestion ?? null) : null,
            },
      );
      this.transport.notify();
      return { ok: true };
    }
    const state = this.tabs.get(tabId);
    if (
      !settings.enabled ||
      profile.replyMode === 'OFF' ||
      !state?.status.ready ||
      state.status.context?.contextId !== request.context.contextId ||
      state.status.context.chatKey !== request.context.chatKey ||
      request.context.profileId !== profile.id
    )
      return { ok: false };
    let receivedAt = Date.now();
    if (request.unreadGrantId) {
      const grant = this.unreadGrants.get(tabId);
      if (!grant || grant.id !== request.unreadGrantId) return { ok: false };
      this.unreadGrants.delete(tabId);
      const target = grant.request;
      if (
        grant.revision !== settings.revision ||
        target.profileId !== profile.id ||
        !profile.autoOpenUnread ||
        (target.existingUnread && !profile.includeExistingUnread) ||
        !profile.webAutoSendOptIn ||
        profile.replyMode !== 'AUTO_REPLY_WEB' ||
        settings.takeovers[request.context.chatKey]?.profileId === profile.id ||
        !insideReplyHours(profile) ||
        target.fromContextId === request.context.contextId ||
        target.titleKey !== state.status.context.titleKey ||
        (target.targetKey && target.targetKey !== request.context.chatKey) ||
        receivedAt - target.observedAt >=
          Math.min(profile.behavior.duplicateWindowSeconds, 300) * 1000
      )
        return { ok: false };
      receivedAt = target.observedAt;
    }
    const stored = dedupSchema.safeParse(
      (await this.local.get('assistant.seen.v1'))['assistant.seen.v1'],
    );
    // A tab lookup or storage read can overlap a pause/profile/policy edit.
    // Check the exact admitted revision before reserving this source.
    if ((await this.repository.load()).revision !== settings.revision)
      return { ok: false };
    const now = Date.now();
    const seen = Object.fromEntries(
      Object.entries(stored.success ? stored.data : {})
        .filter(
          ([, time]) =>
            now - time < profile.behavior.duplicateWindowSeconds * 1000,
        )
        .slice(-255),
    );
    if (seen[request.eventKey]) return this.automaticAck(tabId);
    await this.local.set({
      'assistant.seen.v1': { ...seen, [request.eventKey]: now },
    });
    // A reserved source is not replayed if policy changes during persistence,
    // but it must not enter live state, create a ticket or schedule a reply.
    if ((await this.repository.load()).revision !== settings.revision)
      return { ok: true };
    this.cancelAutomatic(tabId);
    state.message = {
      eventKey: request.eventKey,
      text: request.text,
      receivedAt,
    };
    state.suggestion = null;
    this.transport.notify();
    if (settings.takeovers[request.context.chatKey]?.profileId === profile.id)
      return { ok: true };
    // Record an explicit callback immediately; a later text/cooldown may
    // replace generation, but must not erase the customer's callback request.
    if (detectCallbackRequest(request.text))
      await this.saveHandoff(
        profile,
        request.context,
        state.message,
        'CALLBACK',
        settings.revision,
      );
    if (
      !settings.connections[profile.id]?.autoSuggest &&
      profile.replyMode !== 'AUTO_REPLY_WEB'
    )
      return { ok: true };
    const id = crypto.randomUUID();
    state.suggestion = {
      id,
      state: 'WAITING',
      reply: '',
      needsHuman: false,
      provider: '',
      model: '',
      error: '',
    };
    this.pendingAutomatic.set(tabId, {
      state,
      context: request.context,
      revision: settings.revision,
      eventKey: request.eventKey,
      suggestionId: id,
    });
    this.transport.notify();
    await this.flushAutomatic(tabId);
    return this.automaticAck(tabId);
  }
  private automaticAck(tabId: number) {
    return this.pendingAutomatic.has(tabId)
      ? { ok: true, pollAfterMs: 1000 }
      : { ok: true };
  }
  private cancelAutomatic(tabId: number, error?: string) {
    const pending = this.pendingAutomatic.get(tabId);
    this.pendingAutomatic.delete(tabId);
    if (pending && pending.state.suggestion?.id === pending.suggestionId) {
      pending.state.suggestion =
        error && pending.state.suggestion
          ? {
              ...pending.state.suggestion,
              state: 'ERROR',
              needsHuman: true,
              error,
            }
          : null;
      this.transport.notify();
    }
  }
  private async flushAutomatic(tabId: number) {
    const pending = this.pendingAutomatic.get(tabId);
    if (!pending) return;
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    const { state, context } = pending;
    if (this.pendingAutomatic.get(tabId) !== pending) return;
    if (
      profile?.replyMode === 'AUTO_REPLY_WEB' &&
      profile.backgroundReplies &&
      !(await this.automaticTabAllowed(tabId, profile))
    ) {
      this.cancelAutomatic(tabId, 'INACTIVE_OR_CHANGED_CHAT');
      return;
    }
    if (
      !settings.enabled ||
      settings.revision !== pending.revision ||
      !profile ||
      profile.id !== context.profileId ||
      profile.replyMode === 'OFF' ||
      (profile.replyMode !== 'AUTO_REPLY_WEB' &&
        !settings.connections[profile.id]?.autoSuggest) ||
      settings.takeovers[context.chatKey]?.profileId === context.profileId ||
      this.tabs.get(tabId) !== state ||
      !state.status.ready ||
      state.status.context?.contextId !== context.contextId ||
      state.status.context.chatKey !== context.chatKey ||
      state.message?.eventKey !== pending.eventKey ||
      state.suggestion?.id !== pending.suggestionId
    ) {
      this.cancelAutomatic(tabId, 'SETTINGS_CHANGED');
      return;
    }
    const receivedAt = state.message.receivedAt;
    const expiresAt =
      (receivedAt ?? 0) +
      Math.min(profile.behavior.duplicateWindowSeconds, 300) * 1000;
    if (receivedAt === undefined || Date.now() >= expiresAt) {
      this.cancelAutomatic(tabId, 'MESSAGE_EXPIRED');
      return;
    }
    const scope = chatScope(context);
    // Only one automatic request per business/chat; newer text replaces the
    // pending item and invalidates the older response rather than racing it.
    if (this.automaticRuns.has(scope)) return;
    let dueAt = this.cooldowns.has(scope)
      ? (this.cooldowns.get(scope) ?? 0) +
        profile.behavior.perChatCooldownSeconds * 1000
      : 0;
    if (profile.replyMode === 'AUTO_REPLY_WEB') {
      try {
        dueAt = Math.max(
          dueAt,
          await this.journal.cooldownUntil(profile, context.chatKey),
        );
      } catch {
        this.cancelAutomatic(tabId, 'DELIVERY_STORAGE_ERROR');
        return;
      }
    }
    if (dueAt >= expiresAt) {
      this.cancelAutomatic(tabId, 'COOLDOWN_TOO_LONG');
      return;
    }
    if (Date.now() < dueAt) return;
    if (this.pendingAutomatic.get(tabId) !== pending) return;
    this.pendingAutomatic.delete(tabId);
    this.cooldowns.set(scope, Date.now());
    if (this.cooldowns.size > 256)
      this.cooldowns.delete(this.cooldowns.keys().next().value ?? '');
    const run = Symbol();
    this.automaticRuns.set(scope, run);
    void this.generate(state, settings, true)
      .finally(() => {
        if (this.automaticRuns.get(scope) !== run) return;
        this.automaticRuns.delete(scope);
        // Serialized with incoming events and authorization. A later poll also
        // advances pending work, without relying on worker setTimeout survival.
        const next = this.queue.then(async () => {
          for (const [pendingTab, entry] of this.pendingAutomatic)
            if (chatScope(entry.context) === scope)
              await this.flushAutomatic(pendingTab);
        });
        this.queue = next.catch(() => undefined);
      })
      .catch(() => undefined);
  }
  private async generate(
    state: LiveState,
    settings: Settings,
    automatic = false,
  ) {
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    const context = state.status.context;
    const message = state.message;
    if (!profile || !context || !message) return;
    const id = crypto.randomUUID();
    state.suggestion = {
      id,
      state: 'GENERATING',
      reply: '',
      needsHuman: false,
      provider: '',
      model: '',
      error: '',
    };
    this.transport.notify();
    try {
      if (detectCallbackRequest(message.text)) {
        await this.prepareHandoff(
          state,
          settings,
          id,
          profile,
          context,
          message,
          'CALLBACK',
          automatic,
        );
        return;
      }
      const token = settings.connections[profile.id]?.token;
      if (!token) throw new BackendFailure('NOT_CONFIGURED');
      await this.backend.sync(token, profile);
      const status = await this.backend.status(token);
      this.metadata.set(profile.id, { ...status, paired: true, error: '' });
      if (profile.behavior.replyDelayMinSeconds > 5)
        throw new BackendFailure('DELAY_TOO_LONG');
      if (profile.behavior.replyDelayMinSeconds > 0)
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              profile.behavior.replyDelayMinSeconds,
              profile.behavior.replyDelayMaxSeconds,
            ) * 1000,
          ),
        );
      const beforeRequest = await this.repository.load();
      if (
        beforeRequest.revision !== settings.revision ||
        this.tabs.get(state.tabId) !== state ||
        state.message?.eventKey !== message.eventKey ||
        state.suggestion?.id !== id
      )
        throw new BackendFailure('SETTINGS_CHANGED');
      const response = await this.backend.suggest(token, {
        profileId: profile.id,
        chatKey: context.chatKey,
        requestId: id,
        text: message.text,
      });
      const current = await this.repository.load();
      if (
        this.tabs.get(state.tabId) !== state ||
        state.message?.eventKey !== message.eventKey ||
        state.suggestion?.id !== id ||
        current.revision !== settings.revision ||
        !current.enabled ||
        current.activeProfileId !== profile.id
      ) {
        if (state.suggestion?.id === id)
          state.suggestion = {
            ...state.suggestion,
            state: 'ERROR',
            error: 'SETTINGS_CHANGED',
          };
        this.transport.notify();
        return;
      }
      if (response.requestId !== id) throw new BackendFailure('INVALID_OUTPUT');
      if (
        response.needsHuman ||
        detectHandoffPromise(response.reply) ||
        response.reply === safeFallback(detectLanguage(message.text, profile))
      ) {
        await this.prepareHandoff(
          state,
          settings,
          id,
          profile,
          context,
          message,
          'UNRESOLVED',
          automatic,
        );
        return;
      }
      state.suggestion = {
        id,
        state: 'READY',
        reply: response.reply,
        needsHuman: response.needsHuman,
        provider: response.provider,
        model: response.model,
        error: '',
      };
      if (automatic && profile.replyMode === 'AUTO_REPLY_WEB')
        await this.autoSend(state, settings);
    } catch (error) {
      if (state.suggestion?.id !== id || this.tabs.get(state.tabId) !== state)
        return;
      const code =
        error instanceof BackendFailure
          ? error.message
          : 'PROVIDER_UNAVAILABLE';
      if (code !== 'SETTINGS_CHANGED') {
        const current = await this.repository.load();
        if (
          current.revision === settings.revision &&
          state.message?.eventKey === message.eventKey
        )
          await this.saveHandoff(
            profile,
            context,
            message,
            'UNRESOLVED',
            settings.revision,
          );
      }
      // Saving the failure note yields to newer events. Do not overwrite a
      // replacement reply while its request is waiting or generating.
      if (
        state.suggestion?.id !== id ||
        this.tabs.get(state.tabId) !== state ||
        state.message?.eventKey !== message.eventKey
      )
        return;
      state.suggestion = {
        id,
        state: 'ERROR',
        reply: '',
        needsHuman: true,
        provider: '',
        model: '',
        error: code,
      };
      this.metadata.set(profile.id, {
        configured: false,
        provider: null,
        model: '',
        paired: Boolean(settings.connections[profile.id]?.token),
        error: code,
      });
    }
    this.transport.notify();
  }
  private async prepareHandoff(
    state: LiveState,
    settings: Settings,
    id: string,
    profile: BusinessProfile,
    context: AdapterContext,
    message: NonNullable<LiveState['message']>,
    reason: HandoffReason,
    automatic: boolean,
  ) {
    const handoff = await this.saveHandoff(
      profile,
      context,
      message,
      reason,
      settings.revision,
    );
    const current = await this.repository.load();
    if (
      current.revision !== settings.revision ||
      this.tabs.get(state.tabId) !== state ||
      state.message?.eventKey !== message.eventKey ||
      state.suggestion?.id !== id
    ) {
      if (this.tabs.get(state.tabId) === state && state.suggestion?.id === id) {
        state.suggestion = {
          ...state.suggestion,
          state: 'ERROR',
          error: 'SETTINGS_CHANGED',
        };
        this.transport.notify();
      }
      return;
    }
    state.suggestion = {
      id,
      state: 'READY',
      reply: handoffReply(profile, message.text, handoff.state === 'SAVED'),
      needsHuman: true,
      handoff,
      provider: 'assistant',
      model: 'admin-follow-up',
      error: '',
    };
    this.transport.notify();
    if (automatic && profile.replyMode === 'AUTO_REPLY_WEB')
      await this.autoSend(state, settings);
  }
  private async canSend(pending: {
    tabId: number;
    context: AdapterContext;
    eventKey: string;
    suggestionId: string;
    revision: number;
  }) {
    const initial = await this.repository.load();
    const currentProfile = initial.profiles.find(
      (item) => item.id === initial.activeProfileId,
    );
    // Query the permitted tab before the final settings read. Revocation during
    // this asynchronous Chrome call must deny the pending transaction.
    if (
      !currentProfile ||
      !(await this.automaticTabAllowed(pending.tabId, currentProfile))
    )
      return false;
    const currentSuggestion = this.tabs.get(pending.tabId)?.suggestion;
    const handoff = currentSuggestion?.handoff;
    if (handoff?.state === 'SAVED') {
      if (!currentProfile || currentProfile.id !== pending.context.profileId)
        return false;
      try {
        const ticket = (await this.handoffs.list(currentProfile)).find(
          (record) => record.id === handoff.id,
        );
        if (
          !ticket ||
          ticket.chatKey !== pending.context.chatKey ||
          ticket.sourceEventKey !== pending.eventKey
        )
          return false;
      } catch {
        return false;
      }
    }
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    const state = this.tabs.get(pending.tabId);
    return Boolean(
      settings.enabled &&
      settings.revision === pending.revision &&
      profile?.id === pending.context.profileId &&
      profile.replyMode === 'AUTO_REPLY_WEB' &&
      profile.webAutoSendOptIn &&
      insideReplyHours(profile) &&
      settings.takeovers[pending.context.chatKey]?.profileId !== profile.id &&
      state?.status.ready &&
      state.status.context?.contextId === pending.context.contextId &&
      state.status.context.chatKey === pending.context.chatKey &&
      state.message?.eventKey === pending.eventKey &&
      state.message.receivedAt !== undefined &&
      Date.now() - state.message.receivedAt <=
        Math.min(profile.behavior.duplicateWindowSeconds, 300) * 1000 &&
      state.suggestion?.id === pending.suggestionId &&
      state.suggestion.state === 'READY' &&
      this.eligibleReply(state, profile),
    );
  }
  private eligibleReply(state: LiveState, profile: BusinessProfile) {
    const suggestion = state.suggestion;
    return Boolean(
      suggestion &&
      ((suggestion.handoff &&
        state.message &&
        suggestion.reply ===
          handoffReply(
            profile,
            state.message.text,
            suggestion.handoff.state === 'SAVED',
          )) ||
        !suggestion.needsHuman ||
        (suggestion.standardFallback &&
          state.message &&
          suggestion.reply ===
            safeFallback(detectLanguage(state.message.text, profile)))),
    );
  }
  private async autoSend(state: LiveState, settings: Settings) {
    const context = state.status.context;
    const message = state.message;
    const suggestion = state.suggestion;
    const profile = settings.profiles.find(
      (item) => item.id === context?.profileId,
    );
    if (!context || !message || !suggestion || !profile) return;
    const block = (reason: string) => {
      suggestion.delivery = { state: 'BLOCKED', reason };
      this.transport.notify();
    };
    const pending = {
      tabId: state.tabId,
      context,
      eventKey: message.eventKey,
      suggestionId: suggestion.id,
      revision: settings.revision,
      replyHash: await digest(suggestion.reply),
    };
    if (!this.eligibleReply(state, profile)) {
      block('HUMAN_REVIEW_REQUIRED');
      return;
    }
    if (!(await this.canSend(pending))) {
      block('INACTIVE_OR_CHANGED_CHAT');
      return;
    }
    let claim: Awaited<ReturnType<DeliveryJournal['claim']>>;
    try {
      claim = await this.journal.claim(
        profile,
        context.chatKey,
        message.eventKey,
      );
    } catch {
      block('DELIVERY_STORAGE_ERROR');
      return;
    }
    if (!claim.ok) {
      block(claim.reason);
      return;
    }
    const deliveryId = crypto.randomUUID();
    this.deliveries.set(deliveryId, pending);
    suggestion.delivery = { state: 'SENDING', reason: '' };
    this.transport.notify();
    let result: AutoSendResult = {
      state: 'UNCERTAIN',
      reason: 'SEND_UNCONFIRMED',
    };
    try {
      const response = await this.transport.send(state.tabId, {
        type: 'SEND_AUTOMATIC_REPLY',
        version: 1,
        context,
        sourceEventKey: message.eventKey,
        deliveryId,
        text: suggestion.reply,
      });
      const parsed = AutoSendResultSchema.safeParse(response);
      if (parsed.success) result = parsed.data;
    } catch {
      /* A lost acknowledgement must never trigger an automatic retry. */
    } finally {
      this.deliveries.delete(deliveryId);
    }
    try {
      await this.journal.finish(claim.key, result.state);
    } catch {
      result = { state: 'UNCERTAIN', reason: 'SEND_UNCONFIRMED' };
    }
    suggestion.delivery = result;
    this.transport.notify();
  }
  async setTakeover(context: AdapterContext, paused: boolean) {
    await this.repository.update((settings) => {
      const current = this.snapshot(settings).live?.status.context;
      if (
        !current ||
        current.contextId !== context.contextId ||
        current.chatKey !== context.chatKey ||
        current.profileId !== context.profileId ||
        settings.activeProfileId !== context.profileId
      )
        throw new LiveFailure('STALE_DRAFT');
      const takeovers = { ...settings.takeovers };
      if (paused)
        takeovers[context.chatKey] = {
          profileId: context.profileId,
          chatKey: context.chatKey,
          pausedAt: Date.now(),
          ...(current.titleKey ? { titleKey: current.titleKey } : {}),
        };
      else {
        if (takeovers[context.chatKey]?.profileId !== context.profileId)
          throw new LiveFailure('STALE_DRAFT');
        delete takeovers[context.chatKey];
      }
      return { ...settings, takeovers };
    });
    if (paused)
      for (const [tabId, pending] of this.pendingAutomatic)
        if (chatScope(pending.context) === chatScope(context))
          this.cancelAutomatic(tabId);
    this.transport.notify();
  }
  async connect(token: string, autoSuggest: boolean) {
    const settings = await this.repository.load();
    const profile = settings.profiles.find(
      (item) => item.id === settings.activeProfileId,
    );
    if (!profile) throw new LiveFailure('BACKEND_ERROR');
    const credential = token || settings.connections[profile.id]?.token || '';
    try {
      const status = await this.backend.status(credential);
      if (!status.configured) throw new BackendFailure('NOT_CONFIGURED');
      await this.backend.sync(credential, profile);
      await this.repository.update((current) => {
        if (
          current.activeProfileId !== profile.id ||
          current.revision !== settings.revision
        )
          throw new LiveFailure('STALE_DRAFT');
        return {
          ...current,
          connections: {
            ...current.connections,
            [profile.id]: { token: credential, autoSuggest },
          },
        };
      });
      this.metadata.set(profile.id, { ...status, paired: true, error: '' });
    } catch (error) {
      this.metadata.set(profile.id, {
        configured: false,
        provider: null,
        model: '',
        paired: false,
        error:
          error instanceof BackendFailure ? error.message : 'BACKEND_ERROR',
      });
      this.transport.notify();
      throw new LiveFailure('BACKEND_ERROR');
    }
    this.transport.notify();
  }
  async disconnect() {
    const settings = await this.repository.load();
    await this.repository.update((current) => ({
      ...current,
      connections: {
        ...current.connections,
        [settings.activeProfileId]: { token: '', autoSuggest: false },
      },
    }));
    this.metadata.delete(settings.activeProfileId);
    await this.reset();
  }
  async reconnect() {
    this.unreadGrants.clear();
    for (const tabId of this.pendingAutomatic.keys())
      this.cancelAutomatic(tabId);
    try {
      if (!this.transport.reconnect) throw new Error('Unavailable');
      await this.transport.reconnect();
      this.transport.notify();
    } catch {
      throw new LiveFailure('WHATSAPP_UNAVAILABLE');
    }
  }
  async retry() {
    const settings = await this.repository.load();
    const state = this.snapshot(settings).live;
    if (
      !state?.message ||
      (state.suggestion?.delivery !== undefined &&
        state.suggestion.delivery.state !== 'BLOCKED') ||
      !settings.enabled ||
      !settings.profiles.some(
        (profile) =>
          profile.id === settings.activeProfileId &&
          profile.replyMode !== 'OFF',
      )
    )
      throw new LiveFailure('STALE_DRAFT');
    this.cancelAutomatic(state.tabId);
    void this.generate(state, settings).catch(() => undefined);
  }
  async insert(id: string, text: string) {
    const settings = await this.repository.load();
    const state = this.snapshot(settings).live;
    if (
      !settings.enabled ||
      !state?.status.context ||
      (state.suggestion?.delivery &&
        state.suggestion.delivery.state !== 'BLOCKED') ||
      state.suggestion?.id !== id ||
      state.suggestion.state !== 'READY' ||
      !settings.profiles.some(
        (profile) =>
          profile.id === settings.activeProfileId &&
          profile.replyMode !== 'OFF',
      )
    )
      throw new LiveFailure('STALE_DRAFT');
    const result = await this.transport.send(state.tabId, {
      type: 'INSERT_APPROVED_DRAFT',
      version: 1,
      context: state.status.context,
      sourceEventKey: state.message?.eventKey,
      text,
    });
    if (!z.strictObject({ ok: z.literal(true) }).safeParse(result).success)
      throw new LiveFailure('COMPOSER_BUSY');
  }
  async reset() {
    this.unreadGrants.clear();
    const tabIds = [...this.tabs.keys()];
    for (const tabId of this.pendingAutomatic.keys())
      this.cancelAutomatic(tabId);
    this.tabs.clear();
    // The worker can wake for Save before any open WhatsApp tab reports its
    // status. Discover the allowed tabs so they pick up the saved consent.
    if (this.transport.reconnect) {
      try {
        await this.transport.reconnect();
        this.transport.notify();
        return;
      } catch {
        // A business can configure the assistant before opening WhatsApp.
      }
    }
    await Promise.allSettled(
      tabIds.map((tabId) =>
        this.transport.send(tabId, { type: 'ADAPTER_RESET', version: 1 }),
      ),
    );
    this.transport.notify();
  }
}
