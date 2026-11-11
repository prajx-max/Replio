// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { defaultSelectors } from '@assistant/contracts';
import type {
  AdapterRequest,
  AdapterConfig,
  AdapterContext,
} from '@assistant/contracts';
import { WhatsAppAdapter } from '../src/content/whatsapp/adapter.js';
import { select } from '../src/content/whatsapp/selector-registry.js';

const instances: WhatsAppAdapter[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('crypto', webcrypto);
  document.body.innerHTML =
    '<div id="main"><header><span title="Fixture customer" data-chat-id="chat-a">Fixture customer</span></header><div data-testid="conversation-panel-messages"><div class="message-in" data-id="history"><span class="selectable-text copyable-text">Historical message</span></div></div><footer><div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button></footer></div>';
});
afterEach(() => {
  for (const adapter of instances.splice(0)) adapter.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
const config: AdapterConfig = {
  profileId: 'fixture-profile',
  salt: 'fixture-salt-1234567890',
  enabled: true,
  selectors: defaultSelectors,
  duplicateWindowSeconds: 120,
};
function list() {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="conversation-panel-messages"]',
  );
  if (!element) throw new Error('Missing fixture list');
  return element;
}
function append(id: string, text: string, direction = 'in') {
  const node = document.createElement('div');
  node.className = `message-${direction}`;
  node.dataset.id = id;
  const span = document.createElement('span');
  span.className = 'selectable-text copyable-text';
  span.textContent = text;
  node.append(span);
  list().append(node);
  return node;
}
async function settle(adapter: WhatsAppAdapter) {
  await Promise.resolve();
  await adapter.settled();
  await Promise.resolve();
  await adapter.settled();
}
async function start(
  overrides: Partial<AdapterConfig> = {},
  authorize: () => Promise<unknown> = async () => ({ ok: true }),
  open: () => Promise<unknown> = async () => ({ state: 'SKIP' }),
  messageAck: () => Promise<unknown> = async () => ({ ok: true }),
) {
  const events: AdapterRequest[] = [];
  const adapter = new WhatsAppAdapter(
    document,
    structuredClone({ ...config, ...overrides }),
    async (event) => {
      events.push(event);
      if (event.type === 'ADAPTER_AUTHORIZE_SEND') return authorize();
      if (event.type === 'ADAPTER_OPEN_UNREAD') return open();
      if (event.type === 'ADAPTER_MESSAGE') return messageAck();
      return { ok: true };
    },
  );
  instances.push(adapter);
  await adapter.start();
  await vi.advanceTimersByTimeAsync(1000);
  await settle(adapter);
  return {
    adapter,
    events,
    messages: () => events.filter((event) => event.type === 'ADAPTER_MESSAGE'),
  };
}
describe('bounded message observation diagnostics', () => {
  it.each(['accepted', 'rejected', 'error'] as const)(
    'reports %s worker handoff without customer data',
    async (result) => {
      const h = await start({}, undefined, undefined, async () => {
        if (result === 'error') throw new Error('Private transport detail');
        return { ok: result === 'accepted' };
      });
      append('private-source-id', 'Private customer message');
      await settle(h.adapter);
      const observation = h.events
        .filter((event) => event.type === 'ADAPTER_STATUS')
        .at(-1)?.status.observation;
      expect(observation).toMatchObject({
        baselines: 1,
        lastBaseline: 'CONTEXT_CHANGED',
        incomingCandidates: 1,
        lastHandoff:
          result === 'accepted'
            ? 'WORKER_ACCEPTED'
            : result === 'rejected'
              ? 'WORKER_REJECTED'
              : 'TRANSPORT_ERROR',
      });
      expect(JSON.stringify(observation)).not.toMatch(
        /Private|private-source|customer|fixture-profile/,
      );
      expect(h.messages()).toHaveLength(1);
    },
  );
  it('distinguishes baseline resets and isolates observation counts on business changes', async () => {
    const h = await start();
    append('first', 'Hello');
    await settle(h.adapter);
    await h.adapter.configure({ ...config, profileId: 'different-business' });
    const observation = h.events
      .filter((event) => event.type === 'ADAPTER_STATUS')
      .at(-1)?.status.observation;
    expect(observation).toMatchObject({
      baselines: 1,
      incomingCandidates: 0,
      lastHandoff: 'NONE',
    });
    expect(h.messages()).toHaveLength(1);
  });
});

describe('automatic unread navigation', () => {
  const grantId = 'bc38ffac-c725-47e4-8381-93446d337126';
  async function inbox(
    initial = 0,
    overrides: Partial<AdapterConfig> = {},
    authorize: () => Promise<unknown> = async () => ({
      state: 'OPEN',
      grantId,
    }),
  ) {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const pane = document.createElement('div');
    pane.id = 'pane-side';
    document.body.prepend(pane);
    const row = document.createElement('div');
    row.setAttribute('role', 'row');
    row.innerHTML =
      '<span title="Unread customer">Unread customer</span><span class="preview"></span>';
    const preview = vi.spyOn(
      row.querySelector('.preview')!,
      'textContent',
      'get',
    );
    pane.append(row);
    const badge = document.createElement('span');
    function arrive(count: number) {
      badge.setAttribute('aria-label', count + ' unread messages');
      badge.textContent = String(count);
      row.append(badge);
    }
    if (initial) arrive(initial);
    const clicked = vi.fn();
    row.onclick = clicked;
    const result = await start(
      {
        ...overrides,
        autoSendEnabled: true,
        autoOpenUnread: overrides.autoOpenUnread ?? true,
      },
      undefined,
      authorize,
    );
    function openChat(count: number) {
      document
        .querySelector('#main header span')!
        .setAttribute('title', 'Unread customer');
      document
        .querySelector('#main header span')!
        .removeAttribute('data-chat-id');
      row.setAttribute('aria-selected', 'true');
      badge.remove();
      list().replaceChildren();
      const old = append('history-only', 'Private historical question');
      const historicalRead = vi.spyOn(
        old.querySelector('span')!,
        'textContent',
        'get',
      );
      const divider = document.createElement('div');
      divider.textContent =
        count + (count === 1 ? ' unread message' : ' unread messages');
      list().append(divider);
      return { divider, historicalRead };
    }
    return { ...result, pane, row, preview, clicked, openChat, arrive };
  }
  it('keeps title identity through a redundant attribute rewrite in the real observer', async () => {
    const h = await inbox();
    h.row.querySelector('[title]')!.setAttribute('title', 'Unread customer');
    h.arrive(1);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
    expect(h.preview).not.toHaveBeenCalled();
  });
  it('reports a sanitized worker skip reason after an unread candidate is removed', async () => {
    const h = await inbox(0, {}, async () => ({
      state: 'SKIP',
      reason: 'TARGET_PAUSED',
    }));
    h.arrive(1);
    await settle(h.adapter);
    const status = h.events
      .filter((event) => event.type === 'ADAPTER_STATUS')
      .at(-1)!.status;
    expect(status.unreadPending).toBe(0);
    expect(status.unreadDiagnostics?.lastSkipReason).toBe('TARGET_PAUSED');
    expect(JSON.stringify(status.unreadDiagnostics)).not.toContain(
      'Unread customer',
    );
    expect(h.clicked).not.toHaveBeenCalled();
  });
  it('opens a fresh unread conversation while hidden only with background consent and preserves source proof', async () => {
    const h = await inbox(0, { backgroundReplies: true });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    h.arrive(1);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
    const opened = h.openChat(1);
    append('background-unread-source', 'A fresh background question');
    await settle(h.adapter);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(h.adapter);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toMatchObject({
      unreadGrantId: grantId,
      text: 'A fresh background question',
      context: { chatLabel: 'Unread customer' },
    });
    expect(opened.historicalRead).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'resumes a still-unread background candidate once after backend recovery (existing=%s)',
    async (existing) => {
      let available = false;
      const authorize = vi.fn(async () =>
        available
          ? { state: 'OPEN', grantId }
          : { state: 'WAIT', reason: 'BACKEND_OFFLINE' },
      );
      const h = await inbox(
        existing ? 1 : 0,
        { backgroundReplies: true, includeExistingUnread: existing },
        authorize,
      );
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      if (!existing) h.arrive(1);
      await settle(h.adapter);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(h.clicked).not.toHaveBeenCalled();
      expect(
        h.events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)
          ?.status.unreadBlockedBy,
      ).toBe('BACKEND_OFFLINE');
      await vi.advanceTimersByTimeAsync(1000);
      await settle(h.adapter);
      expect(authorize).toHaveBeenCalledTimes(1);
      available = true;
      await vi.advanceTimersByTimeAsync(2000);
      await settle(h.adapter);
      expect(h.clicked).toHaveBeenCalledTimes(1);
      expect(
        h.events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)
          ?.status.unreadBlockedBy,
      ).toBeUndefined();
      const opened = h.openChat(1);
      append(
        'recovered-unread-source',
        'Question received before backend startup',
      );
      await settle(h.adapter);
      await vi.advanceTimersByTimeAsync(1000);
      await settle(h.adapter);
      expect(h.messages()).toHaveLength(1);
      expect(h.messages()[0]).toMatchObject({
        unreadGrantId: grantId,
        text: 'Question received before backend startup',
      });
      await vi.advanceTimersByTimeAsync(5000);
      await settle(h.adapter);
      expect(h.messages()).toHaveLength(1);
      expect(h.clicked).toHaveBeenCalledTimes(1);
      expect(opened.historicalRead).not.toHaveBeenCalled();
      expect(h.preview).not.toHaveBeenCalled();
    },
  );
  it('reports backend wait changes even when unread phase and pending count stay the same', async () => {
    let offline = false;
    const h = await inbox(1, { includeExistingUnread: true }, async () =>
      offline
        ? { state: 'WAIT', reason: 'BACKEND_OFFLINE' }
        : { state: 'WAIT' },
    );
    const latest = () =>
      h.events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)
        ?.status;
    expect(latest()).toMatchObject({ unreadPending: 1, unread: 'WATCHING' });
    expect(latest()?.unreadBlockedBy).toBeUndefined();
    offline = true;
    await vi.advanceTimersByTimeAsync(1000);
    await settle(h.adapter);
    expect(latest()).toMatchObject({
      unreadPending: 1,
      unread: 'WATCHING',
      unreadBlockedBy: 'BACKEND_OFFLINE',
    });
    offline = false;
    await vi.advanceTimersByTimeAsync(2500);
    await settle(h.adapter);
    expect(latest()).toMatchObject({ unreadPending: 1, unread: 'WATCHING' });
    expect(latest()?.unreadBlockedBy).toBeUndefined();
  });
  it('drops a background unread opening across freeze and never replays its mounted text on resume', async () => {
    const h = await inbox(0, {
      backgroundReplies: true,
      includeExistingUnread: true,
    });
    h.arrive(1);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event('freeze'));
    const opened = h.openChat(1);
    append('during-freeze', 'Do not replay this mounted question');
    await settle(h.adapter);
    document.dispatchEvent(new Event('resume'));
    await settle(h.adapter);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(h.adapter);
    expect(h.messages()).toHaveLength(0);
    expect(opened.historicalRead).not.toHaveBeenCalled();
    append('after-resume', 'A new question after resume');
    await settle(h.adapter);
    expect(h.messages().map((message) => message.text)).toEqual([
      'A new question after resume',
    ]);
  });
  it('baselines an existing unread count, then admits only the latest identified unread text after an increase', async () => {
    const h = await inbox(1);
    expect(h.clicked).not.toHaveBeenCalled();
    h.arrive(2);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
    const opened = h.openChat(2);
    const oldUnread = append('older-unread', 'Unread at startup');
    const oldUnreadRead = vi.spyOn(
      oldUnread.querySelector('span')!,
      'textContent',
      'get',
    );
    append('arrived-after-start', 'New question');
    await settle(h.adapter);
    // WhatsApp clears its unread separator while the chat UI is hydrating.
    opened.divider.remove();
    await settle(h.adapter);
    await vi.advanceTimersByTimeAsync(1500);
    await settle(h.adapter);
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]).toMatchObject({
      unreadGrantId: grantId,
      text: 'New question',
      context: { chatLabel: 'Unread customer' },
    });
    expect(opened.historicalRead).not.toHaveBeenCalled();
    expect(oldUnreadRead).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
  });
  it.each([
    'missing divider',
    'wrong destination',
    'outgoing tail',
    'duplicate ID',
    'unidentified media',
    'later unsupported row',
  ])('skips %s after a native row click', async (kind) => {
    const h = await inbox();
    h.arrive(1);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
    const { divider } = h.openChat(1);
    if (kind === 'missing divider') divider.remove();
    if (kind === 'wrong destination')
      document
        .querySelector('#main header span')!
        .setAttribute('title', 'Another customer');
    if (kind === 'duplicate ID') {
      const clone = append('duplicate', 'Older row');
      divider.before(clone);
    }
    const tail = append(
      kind === 'duplicate ID' ? 'duplicate' : 'last',
      'Question',
      kind === 'outgoing tail' ? 'out' : 'in',
    );
    if (kind === 'unidentified media')
      tail.replaceChildren(document.createElement('img'));
    if (kind === 'later unsupported row') {
      const attachment = document.createElement('div');
      attachment.dataset.id = 'media-after-text';
      list().append(attachment);
    }
    await settle(h.adapter);
    await vi.advanceTimersByTimeAsync(8500);
    await settle(h.adapter);
    expect(h.messages()).toEqual([]);
    expect(
      h.events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)?.status
        .unread,
    ).toBe('UNVERIFIED');
  });
  it('keeps an operator draft, ignores mounting old unread rows and expires pending arrivals', async () => {
    const h = await inbox(0, { duplicateWindowSeconds: 2 });
    const composer = document.querySelector('[contenteditable]')!;
    composer.textContent = 'Operator draft';
    h.arrive(1);
    const oldRow = h.row.cloneNode(true) as HTMLElement;
    oldRow
      .querySelector('[title]')
      ?.setAttribute('title', 'Scrolled into view');
    const oldClick = vi.fn();
    oldRow.onclick = oldClick;
    h.pane.append(oldRow);
    await settle(h.adapter);
    await vi.advanceTimersByTimeAsync(3000);
    expect(composer.textContent).toBe('Operator draft');
    composer.textContent = '';
    await settle(h.adapter);
    expect(h.clicked).not.toHaveBeenCalled();
    expect(oldClick).not.toHaveBeenCalled();
    expect(h.events.some((event) => event.type === 'ADAPTER_OPEN_UNREAD')).toBe(
      false,
    );
  });
  it('runs the existing-unread pass on opt-in but does not restart it on an unrelated settings refresh', async () => {
    const h = await inbox(1);
    const optedIn = {
      ...config,
      autoSendEnabled: true,
      autoOpenUnread: true,
      includeExistingUnread: true,
    };
    expect(h.clicked).not.toHaveBeenCalled();
    await h.adapter.configure(optedIn);
    await vi.advanceTimersByTimeAsync(2000);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
    await h.adapter.configure({ ...optedIn, duplicateWindowSeconds: 100 });
    await vi.advanceTimersByTimeAsync(2000);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
  });
  it('reports a queued chat behind a visible dialog and continues when its mounted container is hidden', async () => {
    const h = await inbox();
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div role="dialog">Send a file</div>';
    document.body.append(wrapper);
    h.arrive(1);
    await settle(h.adapter);
    expect(h.clicked).not.toHaveBeenCalled();
    expect(
      h.events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)
        ?.status,
    ).toMatchObject({
      unreadPending: 1,
      unreadBlockedBy: 'DIALOG',
    });
    wrapper.style.display = 'none';
    await vi.advanceTimersByTimeAsync(700);
    await settle(h.adapter);
    expect(h.clicked).toHaveBeenCalledTimes(1);
  });
  it('does not click after settings revoke navigation during worker authorization', async () => {
    let release!: () => void;
    const permission = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const h = await inbox(0, {}, async () => {
      requested();
      await permission;
      return { state: 'OPEN', grantId };
    });
    h.arrive(1);
    await started;
    await h.adapter.configure({ ...config, autoOpenUnread: false });
    release();
    await settle(h.adapter);
    expect(h.clicked).not.toHaveBeenCalled();
  });
  it('opens from an empty workspace using a fresh timestamp and supports a row activated on mouse-down', async () => {
    const main = document.getElementById('main')!;
    main.remove();
    const h = await inbox();
    const row = h.row.cloneNode(true) as HTMLElement;
    h.row.remove();
    const clock = document.createElement('time');
    clock.dateTime = new Date().toISOString();
    row.append(clock);
    const badge = document.createElement('span');
    badge.setAttribute('aria-label', '1 unread message');
    row.append(badge);
    const duplicateClick = vi.fn();
    row.onclick = duplicateClick;
    row.onmousedown = () => {
      document.body.append(main);
      h.openChat(1);
      row.setAttribute('aria-selected', 'true');
      badge.remove();
      append('new-to-inbox', 'First incoming question');
    };
    h.pane.append(row);
    await settle(h.adapter);
    await vi.advanceTimersByTimeAsync(1500);
    await settle(h.adapter);
    expect(
      h.events.find((event) => event.type === 'ADAPTER_OPEN_UNREAD'),
    ).toMatchObject({ fromContextId: null });
    expect(h.messages().map((message) => message.text)).toEqual([
      'First incoming question',
    ]);
    expect(duplicateClick).not.toHaveBeenCalled();
  });
  it('baselines unread badges received while the WhatsApp tab was hidden', async () => {
    const h = await inbox();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    h.arrive(1);
    await settle(h.adapter);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1500);
    await settle(h.adapter);
    expect(h.clicked).not.toHaveBeenCalled();
  });
  it('skips ambiguous titles and never navigates in open-chat-only mode', async () => {
    const h = await inbox();
    h.pane.append(h.row.cloneNode(true));
    h.arrive(1);
    await settle(h.adapter);
    expect(h.clicked).not.toHaveBeenCalled();
    await h.adapter.configure({
      ...config,
      autoSendEnabled: true,
      autoOpenUnread: false,
    });
    h.pane.lastElementChild?.remove();
    h.arrive(2);
    await settle(h.adapter);
    expect(h.events.some((event) => event.type === 'ADAPTER_OPEN_UNREAD')).toBe(
      false,
    );
  });
});
function contextFrom(events: AdapterRequest[]): AdapterContext {
  const status = [...events]
    .reverse()
    .find((event) => event.type === 'ADAPTER_STATUS');
  if (status?.type !== 'ADAPTER_STATUS' || !status.status.context)
    throw new Error('Expected fixture context');
  return status.status.context;
}
describe('source-bound automatic native sending', () => {
  async function automatic(
    authorize?: () => Promise<unknown>,
    enabled = true,
    overrides: Partial<AdapterConfig> = {},
  ) {
    // New WhatsApp IDs can be opaque: the latest exact source node provides
    // continuity even when the chat header has no strong public identifier.
    document.querySelector('[data-chat-id]')?.removeAttribute('data-chat-id');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const current = await start(
      { ...overrides, autoSendEnabled: enabled },
      authorize,
    );
    const node = append('OPAQUE-FRESH-ID', 'New incoming question');
    await settle(current.adapter);
    const message = current.messages().at(-1);
    if (!message) throw new Error('Missing new incoming source');
    const composer = document.querySelector<HTMLElement>('[contenteditable]');
    const button = document.querySelector<HTMLButtonElement>('button');
    if (!composer || !button) throw new Error('Missing fixture controls');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn((_name: string, _ui: boolean, value: string) => {
        composer.textContent = value;
        return true;
      }),
    });
    const click = vi.fn(() => {
      composer.textContent = '';
    });
    button.onclick = click;
    const command = {
      type: 'SEND_AUTOMATIC_REPLY',
      version: 1,
      context: message.context,
      sourceEventKey: message.eventKey,
      deliveryId: crypto.randomUUID(),
      text: 'A verified reply',
    };
    return { ...current, composer, button, click, node, command };
  }
  it('inserts and clicks native Send once for the exact new incoming source with opaque IDs', async () => {
    const current = await automatic();
    expect(await current.adapter.autoSend(current.command)).toEqual({
      state: 'SENT',
      reason: 'ACCEPTED_BY_WHATSAPP',
    });
    expect(current.click).toHaveBeenCalledTimes(1);
    expect(current.composer.textContent).toBe('');
    expect(
      (
        await current.adapter.autoSend({
          ...current.command,
          deliveryId: crypto.randomUUID(),
        })
      ).state,
    ).toBe('BLOCKED');
    expect(current.click).toHaveBeenCalledTimes(1);
  });
  it('sends successive fresh background messages without permitting hidden manual insertion', async () => {
    const current = await automatic(undefined, true, {
      backgroundReplies: true,
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    expect(
      await current.adapter.insert({
        type: 'INSERT_APPROVED_DRAFT',
        version: 1,
        context: current.command.context,
        sourceEventKey: current.command.sourceEventKey,
        text: 'Approved manual draft',
      }),
    ).toBe(false);
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'SENT',
    );
    append('SECOND-HIDDEN-SOURCE', 'New incoming question');
    await settle(current.adapter);
    const second = current.messages().at(-1)!;
    expect(second.eventKey).not.toBe(current.command.sourceEventKey);
    expect(
      (
        await current.adapter.autoSend({
          ...current.command,
          context: second.context,
          sourceEventKey: second.eventKey,
          deliveryId: crypto.randomUUID(),
        })
      ).state,
    ).toBe('SENT');
    expect(current.click).toHaveBeenCalledTimes(2);
  });
  it('keeps draft preservation and worker authorization mandatory in a hidden tab', async () => {
    const current = await automatic(async () => ({ ok: false }), true, {
      backgroundReplies: true,
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    current.composer.textContent = 'Operator draft';
    expect(await current.adapter.autoSend(current.command)).toEqual({
      state: 'BLOCKED',
      reason: 'COMPOSER_BUSY',
    });
    expect(current.composer.textContent).toBe('Operator draft');
    current.composer.textContent = '';
    expect(await current.adapter.autoSend(current.command)).toEqual({
      state: 'BLOCKED',
      reason: 'AUTHORIZATION_REVOKED',
    });
    expect(current.click).not.toHaveBeenCalled();
  });
  it.each(['freeze', 'disable-background'] as const)(
    'revokes a hidden send waiting for authorization on %s',
    async (reason) => {
      let finish: (value: unknown) => void = () => {};
      const authorization = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      const current = await automatic(() => authorization, true, {
        backgroundReplies: true,
      });
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      const sending = current.adapter.autoSend(current.command);
      await vi.waitFor(() =>
        expect(
          current.events.some(
            (event) => event.type === 'ADAPTER_AUTHORIZE_SEND',
          ),
        ).toBe(true),
      );
      if (reason === 'freeze') document.dispatchEvent(new Event('freeze'));
      else
        await current.adapter.configure({
          ...config,
          autoSendEnabled: true,
          backgroundReplies: false,
        });
      finish({ ok: true });
      expect((await sending).state).toBe('BLOCKED');
      expect(current.click).not.toHaveBeenCalled();
    },
  );
  it('allows manual insertion for weak identity only when bound to the latest incoming source', async () => {
    const current = await automatic();
    const command = {
      type: 'INSERT_APPROVED_DRAFT',
      version: 1,
      context: current.command.context,
      text: 'Manual approved draft',
    };
    expect(await current.adapter.insert(command)).toBe(false);
    expect(
      await current.adapter.insert({
        ...command,
        sourceEventKey: current.command.sourceEventKey,
      }),
    ).toBe(true);
    expect(current.click).not.toHaveBeenCalled();
  });
  it('sends its own reply when the editor represents spaces as nonbreaking spaces', async () => {
    const current = await automatic();
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn((_name: string, _ui: boolean, text: string) => {
        current.composer.textContent = text.replaceAll(' ', '\u00a0');
        return true;
      }),
    });
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'SENT',
    );
    expect(current.click).toHaveBeenCalledTimes(1);
  });
  it('revalidates an equivalent editor replacement instead of rejecting its own inserted draft', async () => {
    const current = await automatic();
    current.click.mockImplementation(() => {
      document.querySelector('[contenteditable]')!.textContent = '';
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn((_name: string, _ui: boolean, text: string) => {
        current.composer.textContent = text;
        queueMicrotask(() => {
          const replacement = current.composer.cloneNode(false);
          replacement.textContent = text;
          current.composer.replaceWith(replacement);
        });
        return true;
      }),
    });
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'SENT',
    );
    expect(current.click).toHaveBeenCalledTimes(1);
  });
  it('never adopts pre-existing composer text even if it equals the AI reply', async () => {
    const current = await automatic();
    current.composer.textContent = current.command.text;
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'BLOCKED',
    );
    expect(current.click).not.toHaveBeenCalled();
  });
  it('does not follow a replacement footer to send a matching draft', async () => {
    const current = await automatic(async () => {
      const footer = document.querySelector('footer');
      if (!footer) throw new Error('Missing footer');
      footer.replaceWith(footer.cloneNode(true));
      return { ok: true };
    });
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'BLOCKED',
    );
    expect(current.click).not.toHaveBeenCalled();
  });
  it.each([
    'mode-off',
    'busy',
    'outgoing',
    'new-incoming',
    'removed-source',
    'changed-id',
    'edited-text',
    'wrong-context',
    'hidden',
    'expired',
    'missing-source',
  ] as const)('does not click when %s invalidates sending', async (reason) => {
    const current = await automatic(undefined, reason !== 'mode-off');
    if (reason === 'busy') current.composer.textContent = 'Operator draft';
    if (reason === 'outgoing')
      append('manual-outgoing', 'Operator already answered', 'out');
    if (reason === 'new-incoming') append('later-incoming', 'A newer message');
    if (reason === 'removed-source') current.node.remove();
    if (reason === 'changed-id') current.node.dataset.id = 'replacement';
    if (reason === 'edited-text')
      current.node.querySelector('span')!.textContent = 'Edited question';
    if (reason === 'wrong-context')
      current.command.context = {
        ...current.command.context,
        contextId: 'different-chat',
      };
    if (reason === 'hidden')
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(121000);
    if (reason === 'missing-source')
      current.command.sourceEventKey = '0'.repeat(64);
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'BLOCKED',
    );
    expect(current.click).not.toHaveBeenCalled();
    if (reason === 'busy')
      expect(current.composer.textContent).toBe('Operator draft');
  });
  it('requires fresh worker authorization and leaves a refused reply as a draft', async () => {
    const current = await automatic(async () => ({ ok: false }));
    expect(await current.adapter.autoSend(current.command)).toEqual({
      state: 'BLOCKED',
      reason: 'AUTHORIZATION_REVOKED',
    });
    expect(current.click).not.toHaveBeenCalled();
    expect(current.composer.textContent).toBe('A verified reply');
  });
  it('rechecks settings, source and operator edits after the authorization await', async () => {
    let finish: (result: unknown) => void = () => undefined;
    const authorization = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const current = await automatic(() => authorization);
    const sending = current.adapter.autoSend(current.command);
    await vi.waitFor(() =>
      expect(
        current.events.some((event) => event.type === 'ADAPTER_AUTHORIZE_SEND'),
      ).toBe(true),
    );
    current.composer.textContent = 'Operator edited this';
    finish({ ok: true });
    expect((await sending).state).toBe('BLOCKED');
    expect(current.click).not.toHaveBeenCalled();
    expect(current.composer.textContent).toBe('Operator edited this');
  });
  it('does not retry a click whose composer acknowledgement is missing', async () => {
    const current = await automatic();
    current.button.onclick = current.click.mockImplementation(() => undefined);
    const sending = current.adapter.autoSend(current.command);
    await vi.waitFor(() => expect(current.click).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1600);
    expect(await sending).toEqual({
      state: 'UNCERTAIN',
      reason: 'SEND_UNCONFIRMED',
    });
    expect((await current.adapter.autoSend(current.command)).state).toBe(
      'BLOCKED',
    );
    expect(current.click).toHaveBeenCalledTimes(1);
  });
  it('stops when the native button is unavailable and preserves the draft', async () => {
    const current = await automatic();
    current.button.remove();
    const sending = current.adapter.autoSend(current.command);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await sending).toEqual({
      state: 'BLOCKED',
      reason: 'SEND_UNAVAILABLE',
    });
    expect(current.composer.textContent).toBe('A verified reply');
  });
});

describe('new-message-only adapter', () => {
  it('resumes the same observer and receives repeated identical text without replaying history', async () => {
    const { adapter, messages, events } = await start();
    append('hello-first', 'Hello');
    await settle(adapter);
    const original = contextFrom(events);
    await adapter.resume(config);
    expect(contextFrom(events)).toEqual(original);
    expect(messages()).toHaveLength(1);
    append('hello-second', 'Hello');
    await settle(adapter);
    expect(messages().map((message) => message.text)).toEqual([
      'Hello',
      'Hello',
    ]);
    expect(messages()[0]?.eventKey).not.toBe(messages()[1]?.eventKey);
  });
  it('reannounces context before a live event even when diagnostics are unchanged after worker loss', async () => {
    const events: AdapterRequest[] = [];
    let registered = false;
    const adapter = new WhatsAppAdapter(document, config, async (event) => {
      if (event.type === 'ADAPTER_STATUS') registered = event.status.ready;
      if (event.type === 'ADAPTER_MESSAGE') expect(registered).toBe(true);
      events.push(event);
      return { ok: true };
    });
    instances.push(adapter);
    await adapter.start();
    await vi.advanceTimersByTimeAsync(1000);
    append('first-identical-layout', 'First');
    await settle(adapter);
    registered = false;
    list().firstElementChild?.remove();
    append('second-identical-layout', 'Second');
    await settle(adapter);
    expect(
      events
        .filter((event) => event.type === 'ADAPTER_MESSAGE')
        .map((event) => event.text),
    ).toEqual(['First', 'Second']);
    for (const [index, event] of events.entries())
      if (event.type === 'ADAPTER_MESSAGE')
        expect(events[index - 1]?.type).toBe('ADAPTER_STATUS');
  });
  it('rejects a source if the message list is replaced while its status acknowledgement is pending', async () => {
    const messages: AdapterRequest[] = [];
    let acknowledgements = 0;
    let canReplace = false;
    const adapter = new WhatsAppAdapter(document, config, async (event) => {
      if (
        event.type === 'ADAPTER_STATUS' &&
        canReplace &&
        ++acknowledgements === 2
      )
        list().replaceWith(list().cloneNode(true));
      if (event.type === 'ADAPTER_MESSAGE') messages.push(event);
      return { ok: true };
    });
    instances.push(adapter);
    await adapter.start();
    await vi.advanceTimersByTimeAsync(1000);
    await settle(adapter);
    canReplace = true;
    append('replaced-source', 'Question in the detached list');
    await settle(adapter);
    expect(acknowledgements).toBeGreaterThanOrEqual(2);
    expect(messages).toHaveLength(0);
  });
  it('rebaselines on changed resume configuration without reading old text into a new profile', async () => {
    const { adapter, messages, events } = await start();
    const history = list().querySelector('span');
    const read = vi.fn(() => 'Old private text');
    if (!history) throw new Error('Missing history');
    Object.defineProperty(history, 'textContent', { get: read });
    const previous = contextFrom(events);
    await adapter.resume({ ...config, profileId: 'other-profile' });
    await vi.advanceTimersByTimeAsync(1000);
    append('new-other-profile', 'New scoped text');
    await settle(adapter);
    expect(read).not.toHaveBeenCalled();
    expect(contextFrom(events).chatKey).not.toBe(previous.chatKey);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.context.profileId).toBe('other-profile');
  });
  it('keeps conservative baselining if the replaced tail has no unique stable ID', async () => {
    const { adapter, messages, events } = await start();
    const sent = append('duplicate-tail', 'An outgoing reply', 'out');
    await settle(adapter);
    const previous = contextFrom(events);
    sent.replaceWith(sent.cloneNode(true), sent.cloneNode(true));
    append('during-ambiguous-replacement', 'Uncertain row');
    await settle(adapter);
    expect(messages()).toHaveLength(0);
    expect(contextFrom(events).contextId).not.toBe(previous.contextId);
    await vi.advanceTimersByTimeAsync(1000);
    append('after-ambiguous-replacement', 'Genuinely new row');
    await settle(adapter);
    expect(messages().map((message) => message.text)).toEqual([
      'Genuinely new row',
    ]);
  });
  it('keeps the second incoming event when the sent tail row is remounted in the same batch', async () => {
    const { adapter, messages, events } = await start();
    append('first-question', 'First question');
    await settle(adapter);
    const sent = append('sent-reply', 'An outgoing reply', 'out');
    await settle(adapter);
    const oldContext = contextFrom(events);
    const replacement = sent.cloneNode(true);
    sent.replaceWith(replacement);
    append('second-question', 'Second question');
    await settle(adapter);
    expect(messages().map((message) => message.text)).toEqual([
      'First question',
      'Second question',
    ]);
    expect(contextFrom(events).contextId).toBe(oldContext.contextId);
  });
  it('baselines and receives the observed bare-ID themed layout without reading history', async () => {
    const main = document.querySelector<HTMLElement>('#main');
    if (!main) throw new Error('Missing main');
    main.style.setProperty('--incoming-background', '#242626');
    main.style.setProperty('--outgoing-background', '#144d37');
    list().innerHTML =
      '<div data-id="ABCDEF123456" data-testid="conv-msg-history"><div data-testid="msg-container"><div style="background-color:#242626"><span class="selectable-text copyable-text">Startup history</span></div></div></div>';
    const text = document.querySelector('.selectable-text');
    if (!text) throw new Error('Missing text');
    const read = vi.fn(() => 'Historic content must never be read');
    Object.defineProperty(text, 'textContent', { get: read });
    const { adapter, events, messages } = await start();
    expect(messages()).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    const incoming = document.createElement('div');
    incoming.dataset.id = 'ABCDEF654321';
    incoming.dataset.testid = 'conv-msg-fresh';
    incoming.innerHTML =
      '<div data-testid="msg-container"><div style="background-color:#242626"><span class="selectable-text copyable-text">A new themed incoming message</span></div></div>';
    list().append(incoming);
    await settle(adapter);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toBe('A new themed incoming message');
    list().append(incoming.cloneNode(true));
    const outgoing = document.createElement('div');
    outgoing.dataset.testid = 'conv-msg-own-reply';
    outgoing.dataset.id = '111111ABCDEF';
    outgoing.innerHTML =
      '<div data-testid="msg-container"><div style="background-color:#144d37"><span class="selectable-text copyable-text">Own outgoing reply</span></div></div>';
    list().append(outgoing);
    await settle(adapter);
    expect(messages()).toHaveLength(1);
    const status = events
      .filter((event) => event.type === 'ADAPTER_STATUS')
      .at(-1)?.status;
    expect(status?.matches.incomingMessage).toBe(3);
    expect(status?.matches.outgoingMessage).toBe(3);
    expect(read).not.toHaveBeenCalled();
  });
  it('reads new incoming public-ID wrappers without message-in classes', async () => {
    const history = list().querySelector<HTMLElement>('.message-in');
    if (!history) throw new Error('Missing fixture history');
    history.className = 'obfuscated-row';
    history.dataset.id = 'false_fixture@lid_OLD';
    const read = vi.fn(() => 'Private startup history');
    const text = history.querySelector('span');
    if (!text) throw new Error('Missing fixture text');
    Object.defineProperty(text, 'textContent', { get: read });
    const { adapter, messages } = await start();
    const incoming = document.createElement('div');
    incoming.dataset.id = 'false_fixture@lid_NEW';
    incoming.innerHTML =
      '<div><span class="selectable-text copyable-text">New incoming hello</span></div>';
    list().append(incoming);
    await settle(adapter);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.text).toBe('New incoming hello');
    expect(read).not.toHaveBeenCalled();
    list().append(incoming.cloneNode(true));
    await settle(adapter);
    expect(messages()).toHaveLength(1);
  });
  it('ignores public-ID outgoing wrappers including nested incoming-looking markup', async () => {
    const { adapter, messages } = await start();
    const outgoing = document.createElement('div');
    outgoing.dataset.id = 'true_fixture@lid_OUT';
    outgoing.innerHTML =
      '<div class="message-in"><span class="selectable-text copyable-text">Quoted incoming-looking content in my own outgoing reply</span></div>';
    list().append(outgoing);
    await settle(adapter);
    expect(messages()).toHaveLength(0);
  });
  it('normalizes nested legacy and public-ID wrappers to one message', async () => {
    const { adapter, messages } = await start();
    const incoming = document.createElement('div');
    incoming.dataset.id = 'false_fixture@lid_MIXED';
    incoming.innerHTML =
      '<div class="message-in"><span class="selectable-text copyable-text">Mixed layout incoming</span></div>';
    list().append(incoming);
    await settle(adapter);
    expect(messages()).toHaveLength(1);
  });
  it('does not consume a future message while an earlier status report is in flight', async () => {
    const events: AdapterRequest[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let statusBlocked = false;
    const adapter = new WhatsAppAdapter(document, config, async (event) => {
      events.push(event);
      if (
        event.type === 'ADAPTER_STATUS' &&
        event.status.ready &&
        event.status.matches.outgoingMessage >= 0
      ) {
        statusBlocked = true;
        await blocked;
      }
      return { ok: true };
    });
    instances.push(adapter);
    await adapter.start();
    await vi.advanceTimersByTimeAsync(1000);
    await settle(adapter);
    append('out-before', 'Operator outgoing', 'out');
    await vi.waitFor(() => expect(statusBlocked).toBe(true));
    append('incoming-during-report', 'Fresh text during asynchronous report');
    await Promise.resolve();
    release();
    await settle(adapter);
    expect(
      events.filter((event) => event.type === 'ADAPTER_MESSAGE'),
    ).toHaveLength(1);
  });
  it('becomes ready despite continuous mutations outside the message list', async () => {
    const events: AdapterRequest[] = [];
    const adapter = new WhatsAppAdapter(document, config, async (event) => {
      events.push(event);
      return { ok: true };
    });
    instances.push(adapter);
    const sidebar = document.createElement('aside');
    document.body.prepend(sidebar);
    await adapter.start();
    for (let tick = 0; tick < 8; tick++) {
      await vi.advanceTimersByTimeAsync(100);
      sidebar.textContent = `Unread counter ${tick}`;
      await settle(adapter);
    }
    const status = events
      .filter((event) => event.type === 'ADAPTER_STATUS')
      .at(-1);
    expect(status?.status.ready).toBe(true);
    append('after-sidebar', 'Fresh incoming text');
    await settle(adapter);
    expect(
      events.filter((event) => event.type === 'ADAPTER_MESSAGE'),
    ).toHaveLength(1);
  });
  it('detects a scoped grid layout and composer attributes hydrated in place', async () => {
    list().removeAttribute('data-testid');
    document.querySelector('#main > div')?.setAttribute('role', 'grid');
    const header = document.querySelector('header span');
    header?.removeAttribute('title');
    header?.setAttribute('dir', 'auto');
    const composer = document.querySelector('[contenteditable]');
    composer?.removeAttribute('role');
    const { adapter, events } = await start();
    expect(
      events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)?.status
        .ready,
    ).toBe(false);
    composer?.setAttribute('role', 'textbox');
    await settle(adapter);
    expect(
      events.filter((event) => event.type === 'ADAPTER_STATUS').at(-1)?.status
        .ready,
    ).toBe(true);
    const node = document.createElement('div');
    node.className = 'message-in';
    node.dataset.id = 'grid-new';
    node.innerHTML =
      '<span class="selectable-text copyable-text">New grid question</span>';
    document.querySelector('[role="grid"]')?.append(node);
    await settle(adapter);
    expect(
      events.filter((event) => event.type === 'ADAPTER_MESSAGE'),
    ).toHaveLength(1);
  });
  it('ignores clones of historical message IDs even when appended later', async () => {
    const { adapter, messages } = await start();
    const old = list().querySelector('.message-in');
    if (!old) throw new Error('Missing fixture history');
    list().append(old.cloneNode(true));
    await settle(adapter);
    expect(messages()).toHaveLength(0);
  });
  it('baselines history without reading its text', async () => {
    const span = document.querySelector('.selectable-text');
    const read = vi.fn(() => 'Private old message');
    if (!span) throw new Error('Missing old message');
    Object.defineProperty(span, 'textContent', { get: read });
    const { messages } = await start();
    expect(messages()).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
  });
  it('detects one new incoming message and suppresses duplicate mutations/clones', async () => {
    const { adapter, messages } = await start();
    const message = append('new-1', 'New customer question');
    await settle(adapter);
    expect(messages()).toHaveLength(1);
    message.setAttribute('data-id', 'new-1');
    list().append(message.cloneNode(true));
    await settle(adapter);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.eventKey).toMatch(/^[a-f0-9]{64}$/);
  });
  it('ignores outgoing and unsupported messages', async () => {
    const { adapter, messages } = await start();
    append('out-1', 'My own reply', 'out');
    const attachment = document.createElement('div');
    attachment.className = 'message-in';
    list().append(attachment);
    await settle(adapter);
    expect(messages()).toHaveLength(0);
  });
  it('ignores history prepended while scrolling', async () => {
    const { adapter, messages } = await start();
    const older = document.createElement('div');
    older.className = 'message-in';
    older.innerHTML =
      '<span class="selectable-text copyable-text">Even older history</span>';
    list().prepend(older);
    await settle(adapter);
    expect(messages()).toHaveLength(0);
  });
  it('ignores asynchronous startup hydration', async () => {
    const events: AdapterRequest[] = [];
    const adapter = new WhatsAppAdapter(document, config, async (event) => {
      events.push(event);
      return { ok: true };
    });
    instances.push(adapter);
    await adapter.start();
    append('hydration', 'Loaded history after initialization');
    await settle(adapter);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(adapter);
    expect(
      events.filter((event) => event.type === 'ADAPTER_MESSAGE'),
    ).toHaveLength(0);
  });
  it('rebaselines on chat change, including two chats with the same title', async () => {
    const { adapter, events, messages } = await start();
    const old = contextFrom(events);
    document
      .querySelector('[data-chat-id]')
      ?.setAttribute('data-chat-id', 'chat-b');
    list().innerHTML =
      '<div class="message-in" data-id="other-history"><span class="selectable-text copyable-text">Other chat history</span></div>';
    await settle(adapter);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(adapter);
    expect(messages()).toHaveLength(0);
    expect(contextFrom(events).chatKey).not.toBe(old.chatKey);
    append('new-b', 'A fresh question');
    await settle(adapter);
    expect(messages()).toHaveLength(1);
  });
  it('ignores messages received while disabled and rebaselines when enabled', async () => {
    const { adapter, messages } = await start();
    await adapter.configure({ ...config, enabled: false });
    await vi.advanceTimersByTimeAsync(1000);
    append('disabled', 'Do not process');
    await settle(adapter);
    await adapter.configure(config);
    await vi.advanceTimersByTimeAsync(1000);
    await settle(adapter);
    expect(messages()).toHaveLength(0);
  });
  it('validates selectors as data and uses ordered CSS fallbacks', async () => {
    expect(select(document, ['[invalid', '#main']).index).toBe(1);
    expect(select(document, ['javascript:alert(1)']).element).toBeNull();
  });
  it('inserts only in the validated current chat and never sends', async () => {
    const { adapter, events } = await start();
    const context = contextFrom(events);
    const composer = document.querySelector<HTMLElement>('[contenteditable]');
    if (!composer) throw new Error('Missing composer');
    const click = vi.spyOn(
      document.querySelector('button') ?? document.createElement('button'),
      'click',
    );
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => {
        composer.textContent = 'Approved reply';
        return true;
      }),
    });
    expect(
      await adapter.insert({
        type: 'INSERT_APPROVED_DRAFT',
        version: 1,
        context,
        text: 'Approved reply',
      }),
    ).toBe(true);
    expect(composer.textContent).toBe('Approved reply');
    expect(click).not.toHaveBeenCalled();
    composer.textContent = '';
    expect(
      await adapter.insert({
        type: 'INSERT_APPROVED_DRAFT',
        version: 1,
        context: { ...context, contextId: 'stale' },
        text: 'Wrong chat',
      }),
    ).toBe(false);
    composer.textContent = 'An existing manual draft';
    expect(
      await adapter.insert({
        type: 'INSERT_APPROVED_DRAFT',
        version: 1,
        context,
        text: 'Do not overwrite',
      }),
    ).toBe(false);
  });
  it('masks phone-like labels and refuses insertion after a chat switch', async () => {
    const header = document.querySelector('[title]');
    header?.setAttribute('title', '+91 98765 43210');
    const { adapter, events } = await start();
    const context = contextFrom(events);
    expect(context.chatLabel).not.toContain('98765');
    header?.setAttribute('data-chat-id', 'other-chat');
    expect(
      await adapter.insert({
        type: 'INSERT_APPROVED_DRAFT',
        version: 1,
        context,
        text: 'Stale reply',
      }),
    ).toBe(false);
  });
});
