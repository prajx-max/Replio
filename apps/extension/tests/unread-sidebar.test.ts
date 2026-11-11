// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSelectors } from '@assistant/contracts';
import type {
  AdapterRequest,
  AdapterConfig,
  UnreadSkipReason,
} from '@assistant/contracts';
import { UnreadInbox } from '../src/content/whatsapp/unread-inbox.js';

const active: UnreadInbox[] = [];
const config: AdapterConfig = {
  profileId: 'business',
  enabled: true,
  autoSendEnabled: true,
  autoOpenUnread: true,
  selectors: defaultSelectors,
  salt: 'sidebar-fixture-salt',
  duplicateWindowSeconds: 5,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.body.innerHTML = '<div id="pane-side"></div>';
});
afterEach(() => {
  active.splice(0).forEach((inbox) => inbox.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function row(name: string, count = 0, role = 'listitem') {
  const entry = document.createElement(role === 'button' ? 'button' : 'div');
  entry.setAttribute('role', role);
  const title = document.createElement('span');
  title.title = name;
  entry.append(title);
  if (count) {
    const badge = document.createElement('span');
    badge.setAttribute('aria-label', count + ' unread messages');
    entry.append(badge);
  }
  return entry;
}
function mount(
  entries: HTMLElement[],
  existing = false,
  allowInitial = true,
  backgroundReplies = false,
  overrides: Partial<AdapterConfig> = {},
) {
  const pane = document.getElementById('pane-side')!;
  pane.replaceChildren(...entries);
  const requests: Extract<AdapterRequest, { type: 'ADAPTER_OPEN_UNREAD' }>[] =
    [];
  const decision: {
    state: string;
    reason?: 'BACKEND_OFFLINE' | 'POLICY_CHANGED' | UnreadSkipReason;
  } = {
    state: 'WAIT',
  };
  const inbox = new UnreadInbox(
    document,
    {
      ...config,
      includeExistingUnread: existing,
      backgroundReplies,
      ...overrides,
    },
    async (request) => {
      if (request.type === 'ADAPTER_OPEN_UNREAD') requests.push(request);
      return decision.state === 'OPEN'
        ? { state: 'OPEN', grantId: crypto.randomUUID() }
        : decision;
    },
    () => {},
    allowInitial,
  );
  active.push(inbox);
  const view = {
    context: null,
    list: null,
    ready: false,
    canLeave: () => true,
    publish: async () => false,
  };
  function mutate(change: () => void) {
    const observer = new MutationObserver(() => {});
    observer.observe(pane, {
      childList: true,
      attributes: true,
      attributeOldValue: true,
      subtree: true,
      characterData: true,
    });
    change();
    inbox.observe(observer.takeRecords());
    observer.disconnect();
  }
  return { pane, inbox, view, requests, decision, mutate };
}
describe('unread sidebar row continuity and initial pass', () => {
  it.each(['title', 'data-chat-id'] as const)(
    'ignores a redundant %s rewrite when a stable row becomes unread',
    async (attribute) => {
      const entry = row('Stable');
      entry.dataset.chatId = 'stable-id';
      const h = mount([entry]);
      await vi.advanceTimersByTimeAsync(1000);
      h.mutate(() => {
        const node = attribute === 'title' ? entry.firstElementChild! : entry;
        node.setAttribute(attribute, node.getAttribute(attribute)!);
        const badge = document.createElement('span');
        badge.setAttribute('aria-label', '1 unread message');
        entry.append(badge);
      });
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(1);
      expect(h.inbox.pendingCount).toBe(1);
      expect(h.inbox.diagnostics.lastSkipReason).toBeUndefined();
    },
  );
  it.each(['rename', 'title roundtrip', 'id roundtrip'] as const)(
    'rejects an identity change during arrival: %s',
    async (change) => {
      const entry = row('Original');
      entry.dataset.chatId = 'original-id';
      const h = mount([entry]);
      await vi.advanceTimersByTimeAsync(1000);
      h.mutate(() => {
        const node =
          change === 'id roundtrip' ? entry : entry.firstElementChild!;
        const attribute = change === 'id roundtrip' ? 'data-chat-id' : 'title';
        const original = node.getAttribute(attribute)!;
        node.setAttribute(attribute, 'different');
        if (change !== 'rename') node.setAttribute(attribute, original);
        const badge = document.createElement('span');
        badge.setAttribute('aria-label', '1 unread message');
        entry.append(badge);
      });
      await h.inbox.advance(h.view);
      expect(h.requests).toEqual([]);
      expect(h.inbox.pendingCount).toBe(0);
      expect(h.inbox.diagnostics.lastSkipReason).toBe('ROW_UNVERIFIED');
    },
  );
  it.each(['original handles', 'unique public ID'] as const)(
    'bridges two separate render tasks using %s without reading a preview',
    async (proof) => {
      const original = row('Returning');
      if (proof === 'unique public ID')
        original.dataset.chatId = 'returning-id';
      const preview = document.createElement('span');
      preview.textContent = 'Private preview';
      original.append(preview);
      const read = vi.spyOn(preview, 'textContent', 'get');
      const h = mount([original]);
      await vi.advanceTimersByTimeAsync(1000);
      h.mutate(() => original.remove());
      await vi.advanceTimersByTimeAsync(50);
      const returned =
        proof === 'original handles' ? original : row('Returning');
      if (proof === 'unique public ID')
        returned.dataset.chatId = 'returning-id';
      h.mutate(() => {
        const badge = document.createElement('span');
        badge.setAttribute('aria-label', '1 unread message');
        returned.append(badge);
        h.pane.append(returned);
      });
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(1);
      expect(h.inbox.pendingCount).toBe(1);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it.each([
    'new title-only row',
    'expired gap',
    'recycled original',
    'duplicate public ID',
  ] as const)('does not infer a fresh arrival through %s', async (failure) => {
    const original = row('Returning');
    if (failure === 'duplicate public ID')
      original.dataset.chatId = 'duplicate-id';
    const h = mount([original]);
    await vi.advanceTimersByTimeAsync(1000);
    h.mutate(() => original.remove());
    await vi.advanceTimersByTimeAsync(failure === 'expired gap' ? 1001 : 50);
    const returned =
      failure === 'new title-only row' ? row('Returning') : original;
    if (failure === 'recycled original')
      original.firstElementChild!.setAttribute('title', 'Other person');
    h.mutate(() => {
      const badge = document.createElement('span');
      badge.setAttribute('aria-label', '1 unread message');
      returned.append(badge);
      h.pane.append(returned);
      if (failure === 'duplicate public ID') {
        const duplicate = row('Different label');
        duplicate.dataset.chatId = 'duplicate-id';
        h.pane.append(duplicate);
      }
    });
    await h.inbox.advance(h.view);
    expect(h.requests).toEqual([]);
    expect(h.inbox.pendingCount).toBe(0);
    expect(h.inbox.diagnostics.lastSkipReason).toBeDefined();
  });
  it('bounds detached read-row metadata to 32 handles', async () => {
    const entries = Array.from({ length: 33 }, (_, i) => row(`Entry ${i}`));
    const h = mount(entries);
    await vi.advanceTimersByTimeAsync(1000);
    h.mutate(() => h.pane.replaceChildren());
    const beyondBound = entries[32]!;
    h.mutate(() => {
      const badge = document.createElement('span');
      badge.setAttribute('aria-label', '1 unread message');
      beyondBound.append(badge);
      h.pane.append(beyondBound);
    });
    await h.inbox.advance(h.view);
    expect(h.requests).toEqual([]);
    expect(h.inbox.pendingCount).toBe(0);
  });
  it.each([
    'original handles',
    'public ID',
    'title-only replacement',
    'expired remount',
  ] as const)(
    'revalidates a queued fresh candidate after pane replacement: %s',
    async (proof) => {
      const entry = row('Queued');
      if (proof === 'public ID') entry.dataset.chatId = 'queued-id';
      const h = mount([entry]);
      await vi.advanceTimersByTimeAsync(1000);
      h.mutate(() => {
        const badge = document.createElement('span');
        badge.setAttribute('aria-label', '1 unread message');
        entry.append(badge);
      });
      await h.inbox.advance(h.view);
      const observedAt = h.requests[0]!.observedAt;
      expect(h.inbox.pendingCount).toBe(1);
      const replacement = document.createElement('div');
      replacement.id = 'pane-side';
      const next =
        proof === 'original handles' || proof === 'expired remount'
          ? entry
          : row('Queued', 1);
      if (proof === 'public ID') next.dataset.chatId = 'queued-id';
      if (proof === 'expired remount') {
        h.mutate(() => h.pane.remove());
        await vi.advanceTimersByTimeAsync(1001);
      }
      h.mutate(() => {
        replacement.append(next);
        if (proof === 'expired remount') document.body.append(replacement);
        else h.pane.replaceWith(replacement);
      });
      await vi.advanceTimersByTimeAsync(500);
      h.decision.state = 'SKIP';
      await h.inbox.advance(h.view);
      if (proof === 'original handles' || proof === 'public ID') {
        expect(h.requests).toHaveLength(2);
        expect(h.requests[1]!.observedAt).toBe(observedAt);
      } else {
        expect(h.requests).toHaveLength(1);
        expect(h.inbox.diagnostics.lastSkipReason).toBe('ROW_UNVERIFIED');
      }
      expect(h.inbox.pendingCount).toBe(0);
    },
  );
  it('revalidates every queued row on pane remount before a longer backend backoff elapses', async () => {
    const entries = [row('First'), row('Second')];
    const h = mount(entries, false, true, true);
    await vi.advanceTimersByTimeAsync(1000);
    h.mutate(() => {
      for (const entry of entries) {
        const badge = document.createElement('span');
        badge.setAttribute('aria-label', '1 unread message');
        entry.append(badge);
      }
    });
    h.decision.reason = 'BACKEND_OFFLINE';
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(2);
    const observedAt = h.requests[0]!.observedAt;
    const replacement = document.createElement('div');
    replacement.id = 'pane-side';
    h.mutate(() => {
      replacement.append(...entries);
      h.pane.replaceWith(replacement);
    });
    await vi.advanceTimersByTimeAsync(2000);
    h.decision.state = 'SKIP';
    h.decision.reason = 'TARGET_PAUSED';
    await h.inbox.advance(h.view);
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(3);
    expect(h.requests.slice(1).map((request) => request.observedAt)).toEqual([
      observedAt,
      observedAt,
    ]);
    expect(new Set(h.requests.map((request) => request.titleKey)).size).toBe(2);
    expect(h.inbox.pendingCount).toBe(0);
  });
  it('expires the render-gap bridge on its timer even without queued candidates', async () => {
    const entry = row('Temporarily detached');
    const pane = document.getElementById('pane-side')!;
    pane.append(entry);
    const view = {
      context: null,
      list: null,
      ready: false,
      canLeave: () => true,
      publish: async () => false,
    };
    const wake = vi.fn(() => {
      void inbox.advance(view);
    });
    const inbox = new UnreadInbox(
      document,
      config,
      async () => ({ state: 'WAIT' }),
      wake,
    );
    active.push(inbox);
    await vi.advanceTimersByTimeAsync(1000);
    const observer = new MutationObserver(() => {});
    observer.observe(pane, { childList: true });
    entry.remove();
    inbox.observe(observer.takeRecords());
    observer.disconnect();
    const before = wake.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(wake.mock.calls.length).toBeGreaterThan(before);
    const afterExpiry = wake.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(wake).toHaveBeenCalledTimes(afterExpiry);
    expect(inbox.pendingCount).toBe(0);
  });
  it.each([false, true])(
    'bounds policy-revision retries without extending freshness (existing=%s)',
    async (existing) => {
      const entry = row('Policy waiting', existing ? 1 : 0);
      const h = mount([entry], existing, true, false, {
        duplicateWindowSeconds: existing ? 120 : 5,
      });
      h.decision.reason = 'POLICY_CHANGED';
      await vi.advanceTimersByTimeAsync(1000);
      if (!existing)
        h.mutate(() => {
          const badge = document.createElement('span');
          badge.setAttribute('aria-label', '1 unread message');
          entry.append(badge);
        });
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(500);
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(existing ? 59500 : 4500);
      h.decision.state = 'OPEN';
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(2);
      expect(h.inbox.pendingCount).toBe(0);
      expect(h.inbox.diagnostics.lastSkipReason).toBe('SOURCE_EXPIRED');
    },
  );
  it('forwards a worker skip reason and clears it for the next verified candidate', async () => {
    const entry = row('Paused customer', 1);
    const h = mount([entry], true);
    h.decision.state = 'SKIP';
    h.decision.reason = 'TARGET_PAUSED';
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.inbox.diagnostics.lastSkipReason).toBe('TARGET_PAUSED');
    h.mutate(() =>
      entry.lastElementChild!.setAttribute('aria-label', '2 unread messages'),
    );
    expect(h.inbox.diagnostics.lastSkipReason).toBeUndefined();
    h.decision.state = 'OPEN';
    await h.inbox.advance(h.view);
    expect(h.inbox.status).toBe('OPENING');
    expect(h.inbox.diagnostics.lastSkipReason).toBeUndefined();
    h.inbox.dispose();
    expect(h.inbox.diagnostics.lastSkipReason).toBeUndefined();
  });
  it('keeps the offline deadline across a row remount and rejects a grant that arrives after it', async () => {
    const pane = document.getElementById('pane-side')!;
    const original = row('Waiting customer', 1);
    pane.append(original);
    const clicked = vi.fn();
    let calls = 0;
    let release = () => {};
    const later = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inbox = new UnreadInbox(
      document,
      { ...config, includeExistingUnread: true, duplicateWindowSeconds: 120 },
      async () => {
        calls++;
        if (calls === 1) return { state: 'WAIT', reason: 'BACKEND_OFFLINE' };
        await later;
        return { state: 'OPEN', grantId: crypto.randomUUID() };
      },
      () => {},
    );
    active.push(inbox);
    const view = {
      context: null,
      list: null,
      ready: false,
      canLeave: () => true,
      publish: async () => false,
    };
    await vi.advanceTimersByTimeAsync(1000);
    await inbox.advance(view);
    expect(inbox.waitingForBackend).toBe(true);
    const observer = new MutationObserver(() => {});
    observer.observe(pane, { childList: true, subtree: true });
    const replacement = row('Waiting customer', 1);
    replacement.onclick = clicked;
    original.replaceWith(replacement);
    inbox.observe(observer.takeRecords());
    observer.disconnect();
    await vi.advanceTimersByTimeAsync(59000);
    const pending = inbox.advance(view);
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.advanceTimersByTimeAsync(1100);
    release();
    await pending;
    expect(inbox.pendingCount).toBe(0);
    expect(inbox.waitingForBackend).toBe(false);
    expect(clicked).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'expires an offline candidate without opening it or rescanning its badge (existing=%s)',
    async (existing) => {
      const entry = row('Waiting customer', existing ? 1 : 0);
      const clicked = vi.fn();
      entry.onclick = clicked;
      const h = mount([entry], existing, true, true, {
        duplicateWindowSeconds: existing ? 120 : 5,
      });
      h.decision.reason = 'BACKEND_OFFLINE';
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      await vi.advanceTimersByTimeAsync(1000);
      if (!existing)
        h.mutate(() => {
          const badge = document.createElement('span');
          badge.setAttribute('aria-label', '1 unread message');
          entry.append(badge);
        });
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(1);
      expect(h.inbox.pendingCount).toBe(1);
      expect(h.inbox.waitingForBackend).toBe(true);
      await vi.advanceTimersByTimeAsync(existing ? 60000 : 5000);
      h.decision.state = 'OPEN';
      await h.inbox.advance(h.view);
      expect(h.inbox.pendingCount).toBe(0);
      expect(h.inbox.waitingForBackend).toBe(false);
      expect(h.requests).toHaveLength(1);
      expect(clicked).not.toHaveBeenCalled();
      h.inbox.observe([]);
      await h.inbox.advance(h.view);
      expect(h.inbox.pendingCount).toBe(0);
      expect(clicked).not.toHaveBeenCalled();
    },
  );
  it('retains the pending initial backlog across tab switches with background consent', async () => {
    const h = mount([row('First', 1), row('Second', 2)], true, true, true);
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    h.decision.state = 'SKIP';
    await vi.advanceTimersByTimeAsync(600);
    await h.inbox.advance(h.view);
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(0);
    expect(h.requests).toHaveLength(3);
    expect(new Set(h.requests.map((request) => request.titleKey)).size).toBe(2);
    expect(h.inbox.status).toBe('WATCHING');
    expect(h.inbox.diagnostics.visible).toBe(false);
  });
  it('observes new unread counts while hidden without admitting old baselined badges', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const old = row('Old', 2);
    const fresh = row('Fresh');
    const h = mount([old, fresh], false, true, true);
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(0);
    h.mutate(() => {
      const badge = document.createElement('span');
      badge.setAttribute('aria-label', '1 unread message');
      fresh.append(badge);
    });
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.existingUnread).toBeUndefined();
    expect(h.inbox.pendingCount).toBe(1);
  });
  function themedRow(name: string, count: number) {
    const entry = row(name);
    entry.style.setProperty('--unread-marker-background', '#25d366');
    entry.style.setProperty('--unread-marker-text', '#111b21');
    const badge = document.createElement('span');
    badge.style.backgroundColor = '#25d366';
    badge.style.color = '#111b21';
    badge.innerHTML = `<span>${count}</span>`;
    entry.append(badge);
    return { entry, badge };
  }
  it('recognizes an unlabeled theme-colored count and never reads numeric previews or titles', async () => {
    const { entry, badge } = themedRow('Customer', 1);
    badge.setAttribute('aria-hidden', 'true');
    const preview = document.createElement('span');
    preview.textContent = '1234';
    const clock = document.createElement('span');
    clock.textContent = '22:48';
    entry.append(preview, clock);
    const previewRead = vi.spyOn(preview, 'textContent', 'get');
    const clockRead = vi.spyOn(clock, 'textContent', 'get');
    const titleRead = vi.spyOn(
      entry.querySelector('[title]')!,
      'textContent',
      'get',
    );
    const h = mount([entry], true);
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.existingUnread).toBe(true);
    expect(previewRead).not.toHaveBeenCalled();
    expect(clockRead).not.toHaveBeenCalled();
    expect(titleRead).not.toHaveBeenCalled();
  });
  it('opens a themed unread row through its nested native conversation button', async () => {
    const { entry, badge } = themedRow('Customer', 1);
    const button = document.createElement('button');
    button.style.setProperty('--unread-marker-background', '#25d366');
    button.style.setProperty('--unread-marker-text', '#111b21');
    button.append(entry.querySelector('[title]')!, badge);
    entry.append(button);
    const clicked = vi.fn();
    button.onclick = clicked;
    const h = mount([entry], true);
    h.decision.state = 'OPEN';
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it.each([
    'missing theme',
    'transparent theme',
    'equal theme colors',
    'wrong foreground',
    'hidden badge',
    'hidden ancestor',
    'ambiguous counts',
    'numeric title',
    'unrelated action button',
  ])(
    'rejects unsupported or ambiguous theme badge evidence: %s',
    async (kind) => {
      const { entry, badge } = themedRow('Customer', 1);
      if (kind === 'missing theme')
        entry.style.removeProperty('--unread-marker-background');
      if (kind === 'transparent theme')
        entry.style.setProperty('--unread-marker-background', 'transparent');
      if (kind === 'equal theme colors')
        entry.style.setProperty('--unread-marker-text', '#25d366');
      if (kind === 'wrong foreground') badge.style.color = '#ffffff';
      if (kind === 'hidden badge') badge.style.display = 'none';
      if (kind === 'hidden ancestor') entry.style.display = 'none';
      if (kind === 'ambiguous counts') {
        const duplicate = badge.cloneNode(true) as HTMLElement;
        duplicate.textContent = '2';
        entry.append(duplicate);
      }
      if (kind === 'numeric title') badge.setAttribute('title', '1');
      if (kind === 'unrelated action button') {
        const button = document.createElement('button');
        badge.replaceWith(button);
        button.append(badge);
      }
      const h = mount([entry], true);
      await vi.advanceTimersByTimeAsync(1000);
      await h.inbox.advance(h.view);
      expect(h.requests).toEqual([]);
    },
  );
  it('does not treat conflicting semantic counters or CSS-hidden badges as an unread count', async () => {
    const conflicting = row('Conflicting', 1);
    const extra = document.createElement('span');
    extra.setAttribute('aria-label', '2 unread messages');
    conflicting.append(extra);
    const hidden = row('Hidden', 1);
    hidden.querySelector<HTMLElement>('[aria-label]')!.style.visibility =
      'hidden';
    const h = mount([conflicting, hidden], true);
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.requests).toEqual([]);
  });
  it.each([
    'nested count',
    'compound row label',
    'decorative aria-hidden badge',
  ])(
    'recognizes a rendered semantic badge with %s without reading the preview',
    async (kind) => {
      const entry = row('Customer');
      const preview = document.createElement('span');
      preview.className = 'preview';
      entry.append(preview);
      const read = vi.spyOn(preview, 'textContent', 'get');
      const badge = document.createElement('span');
      badge.dataset.testid = 'unread-count';
      if (kind === 'nested count') badge.innerHTML = '<span>1</span>';
      else {
        badge.textContent = '1';
        badge.setAttribute('aria-label', '1 unread message');
      }
      if (kind === 'compound row label') {
        delete badge.dataset.testid;
        entry.setAttribute('aria-label', 'Customer, 1 unread message');
      }
      if (kind === 'decorative aria-hidden badge')
        badge.setAttribute('aria-hidden', 'true');
      entry.append(badge);
      const h = mount([entry], true);
      await vi.advanceTimersByTimeAsync(1000);
      await h.inbox.advance(h.view);
      expect(h.requests).toHaveLength(1);
      expect(h.inbox.diagnostics.lastVisibleUnreadRows).toBe(1);
      expect(read).not.toHaveBeenCalled();
    },
  );
  it('recognizes two concurrent increases through full row replacement while baselining an old badge', async () => {
    const h = mount([row('A'), row('B'), row('Old', 1)]);
    await vi.advanceTimersByTimeAsync(1000);
    const b = row('B', 1);
    h.mutate(() =>
      h.pane.replaceChildren(row('A', 1, 'row'), b, row('Old', 1)),
    );
    expect(h.inbox.pendingCount).toBe(2);
    h.decision.state = 'SKIP';
    await h.inbox.advance(h.view);
    const first = h.requests[0];
    h.mutate(() => b.replaceWith(row('B', 1, 'button')));
    expect(h.inbox.pendingCount).toBe(1);
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.titleKey).not.toEqual(first?.titleKey);
    expect(h.requests.every((r) => !r.existingUnread)).toBe(true);
    expect(h.inbox.pendingCount).toBe(0);
  });
  it('rejects ambiguous or renamed targets when remounts lack fresh timestamp proof', async () => {
    const h = mount([row('Same'), row('Same'), row('Original')]);
    await vi.advanceTimersByTimeAsync(1000);
    h.mutate(() => h.pane.replaceChildren(row('Same', 1), row('Different', 1)));
    await h.inbox.advance(h.view);
    expect(h.requests).toEqual([]);
  });
  it('preserves a fresh pending arrival through a title-node-only remount and clicks a native row button', async () => {
    const entry = row('Shop', 0, 'button');
    const h = mount([entry]);
    const clicked = vi.fn();
    entry.onclick = clicked;
    await vi.advanceTimersByTimeAsync(1000);
    h.mutate(() => {
      const replacement = row('Shop', 1, 'button');
      entry.replaceChildren(...replacement.childNodes);
    });
    h.decision.state = 'OPEN';
    await h.inbox.advance(h.view);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('serves a whole visible backlog, retains its order and revalidates old badges at each dispatch', async () => {
    const h = mount(
      Array.from({ length: 40 }, (_, i) => row('Customer ' + i, 1)),
      true,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(40);
    expect(h.inbox.initialSweepStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    h.decision.state = 'SKIP';
    for (let i = 0; i < 40; i++) await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(0);
    expect(h.requests).toHaveLength(41);
    expect(new Set(h.requests.map((r) => r.titleKey)).size).toBe(40);
    expect(h.requests.every((r) => r.existingUnread === true)).toBe(true);
    expect(h.requests[1]?.observedAt).toBe(Date.now());
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(41);
  });
  it('resumes unopened existing chats after settings hides the tab, without repeating the clicked chat', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const h = mount([row('First', 1), row('Second', 2)], true);
    const clicked = vi.fn();
    h.pane.firstElementChild!.addEventListener('click', clicked);
    await vi.advanceTimersByTimeAsync(1000);
    h.decision.state = 'OPEN';
    await h.inbox.advance(h.view);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(h.inbox.pendingCount).toBe(2);
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(1);
    expect(h.requests).toHaveLength(1);
    expect(h.inbox.diagnostics).toEqual({
      visible: false,
      lastVisibleListFound: true,
      lastVisibleRows: 2,
      lastVisibleUnreadRows: 2,
      initialScanPending: false,
      existingUnreadQueued: 1,
    });
    // WhatsApp may completely remount the sidebar while hidden. Neither a
    // newly mounted old badge nor the clicked row belongs to the resumed pass.
    const replacement = document.createElement('div');
    replacement.id = 'pane-side';
    replacement.append(row('First', 1), row('Second', 2), row('Other', 1));
    h.pane.replaceWith(replacement);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    h.decision.state = 'SKIP';
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.titleKey).not.toBe(h.requests[0]?.titleKey);
    expect(h.requests[1]?.existingUnread).toBe(true);
    expect(h.inbox.pendingCount).toBe(0);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('keeps the initial scan armed when hidden before badges settle', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const h = mount([row('Still loading')], true);
    await vi.advanceTimersByTimeAsync(100);
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    h.mutate(() => h.pane.append(row('Unread', 2)));
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.requests).toEqual([]);
    expect(h.inbox.initialSweepStarted).toBe(false);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(650);
    h.decision.state = 'SKIP';
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.existingUnread).toBe(true);
  });
  it('waits for a replacement sidebar without expiring the unopened existing candidates', async () => {
    const h = mount([row('Existing', 1)], true);
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    h.pane.remove();
    h.inbox.observe([]);
    await h.inbox.advance(h.view);
    await vi.advanceTimersByTimeAsync(10000);
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(1);
    expect(h.requests).toHaveLength(1);
    const replacement = document.createElement('div');
    replacement.id = 'pane-side';
    replacement.append(row('Existing', 1));
    document.body.append(replacement);
    h.inbox.observe([]);
    h.decision.state = 'SKIP';
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(2);
    expect(h.inbox.pendingCount).toBe(0);
  });
  it('retains only existing candidates and rejects changed badges after a hidden-tab baseline', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const h = mount(
      [row('Existing', 2), row('Other existing', 1), row('Live')],
      true,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    h.mutate(() => h.pane.lastElementChild!.replaceWith(row('Live', 1)));
    expect(h.inbox.pendingCount).toBe(3);
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    h.mutate(() =>
      h.pane.replaceChildren(
        row('Existing', 3),
        row('Other existing'),
        row('Live', 2),
      ),
    );
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await h.inbox.advance(h.view);
    await h.inbox.advance(h.view);
    expect(h.inbox.pendingCount).toBe(0);
    expect(h.requests).toHaveLength(1);
  });
  it('invalidates an outstanding opening grant while hidden and requests a fresh one on return', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const entry = row('Existing', 1);
    document.getElementById('pane-side')!.append(entry);
    const clicked = vi.fn();
    entry.onclick = clicked;
    let release: (value: unknown) => void = () => {};
    const authorize = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const inbox = new UnreadInbox(
      document,
      { ...config, includeExistingUnread: true },
      authorize,
      () => {},
    );
    active.push(inbox);
    const view = {
      context: null,
      list: null,
      ready: false,
      canLeave: () => true,
      publish: async () => false,
    };
    await vi.advanceTimersByTimeAsync(1000);
    const pending = inbox.advance(view);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    release({ state: 'OPEN', grantId: crypto.randomUUID() });
    await pending;
    expect(clicked).not.toHaveBeenCalled();
    const next = inbox.advance(view);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
    release({ state: 'OPEN', grantId: crypto.randomUUID() });
    await next;
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('reports missing lists, unrecognized rows and absent numeric badges without chat metadata', () => {
    const h = mount([row('Private name')], true);
    expect(h.inbox.diagnostics.lastVisibleRows).toBe(1);
    expect(h.inbox.diagnostics.lastVisibleUnreadRows).toBe(0);
    h.mutate(() => h.pane.replaceChildren(document.createElement('div')));
    expect(h.inbox.diagnostics.lastVisibleListFound).toBe(true);
    expect(h.inbox.diagnostics.lastVisibleRows).toBe(0);
    h.pane.remove();
    h.inbox.observe([]);
    expect(h.inbox.diagnostics.lastVisibleListFound).toBe(false);
    expect(JSON.stringify(h.inbox.diagnostics)).not.toContain('Private');
  });
  it('waits for delayed initial rendering and never rescans old badges on same-page reset or refocus', async () => {
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    const h = mount([], true);
    await vi.advanceTimersByTimeAsync(1000);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.inbox.initialSweepStarted).toBe(false);
    h.mutate(() => h.pane.append(row('Loading')));
    await vi.advanceTimersByTimeAsync(350);
    await h.inbox.advance(h.view);
    expect(h.inbox.initialSweepStarted).toBe(false);
    h.mutate(() => h.pane.append(row('Unread', 3)));
    await vi.advanceTimersByTimeAsync(350);
    await h.inbox.advance(h.view);
    expect(h.inbox.initialSweepStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    h.decision.state = 'SKIP';
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(1);
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1000);
    await h.inbox.advance(h.view);
    expect(h.requests).toHaveLength(1);
    h.inbox.dispose();
    const refreshed = mount([row('Unread', 3)], true, false);
    await vi.advanceTimersByTimeAsync(1000);
    await refreshed.inbox.advance(refreshed.view);
    expect(refreshed.requests).toEqual([]);
  });
});
