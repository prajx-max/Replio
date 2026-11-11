import {
  defaultUnreadSelectors,
  UnreadOpenResultSchema,
} from '@assistant/contracts';
import type {
  AdapterConfig,
  AdapterContext,
  AdapterRequest,
  UnreadSkipReason,
  UnreadSelectors,
} from '@assistant/contracts';
import { hash, readChatTitle, chatIdentity } from './chat-metadata.js';
import { select, matches } from './selector-registry.js';
import { messageDomId, messageNodes } from './reader.js';
import { messageDirection, opaqueColor } from './direction.js';

interface Arrival {
  row: HTMLElement;
  titleNode: HTMLElement;
  title: string;
  publicId: string | undefined;
  count: number;
  at: number;
  existing: boolean;
  missingSince?: number;
  waitDeadline?: number;
  backendOffline?: boolean;
  paneDeadline?: number;
}
interface RowObservation {
  count: number;
  titleNode: HTMLElement;
  since: number;
}
interface DetachedReadRow {
  row: HTMLElement;
  observation: RowObservation;
  title: string;
  publicId: string | undefined;
  expiresAt: number;
}
interface Opening {
  arrival: Arrival;
  grantId: string;
  fromContextId: string | null;
  deadline: number;
  priorNodes: WeakSet<HTMLElement>;
  priorIds: Set<string>;
  proof?: { id: string; list: HTMLElement };
}
interface OpenChat {
  context: AdapterContext | null;
  list: HTMLElement | null;
  ready: boolean;
  canLeave(): boolean;
  publish(
    node: HTMLElement,
    grantId: string,
    observedAt: number,
    valid: () => boolean,
  ): Promise<boolean>;
}
function visibleBadge(node: HTMLElement) {
  // aria-hidden is accessibility metadata, not visual visibility. WhatsApp can
  // hide a decorative count from screen readers while still displaying it.
  if (node.closest('[hidden], [inert]')) return false;
  const view = node.ownerDocument.defaultView;
  if (!view) return false;
  for (let part: HTMLElement | null = node; part; part = part.parentElement) {
    const css = view.getComputedStyle(part);
    if (
      css.display === 'none' ||
      css.visibility === 'hidden' ||
      css.visibility === 'collapse'
    )
      return false;
  }
  return true;
}
function numericBadge(badge: HTMLElement): number | null {
  let leaf = badge;
  for (let depth = 0; depth < 4 && leaf.childElementCount; depth++) {
    // Only a bounded single-child number wrapper, never aggregate row text.
    if (
      leaf.childNodes.length !== 1 ||
      !(leaf.firstChild instanceof HTMLElement)
    )
      return null;
    leaf = leaf.firstChild;
  }
  if (leaf.childElementCount || !leaf.matches('span, div, b, strong'))
    return null;
  const number = leaf.textContent?.trim() ?? '';
  return /^\d{1,4}$/.test(number) ? Number(number) : null;
}
function badgeTheme(row: HTMLElement, selectors: UnreadSelectors) {
  const rules = selectors.themeBadge;
  const view = row.ownerDocument.defaultView;
  if (!rules || !view) return null;
  const css = view.getComputedStyle(row);
  const background = opaqueColor(
    css.getPropertyValue(rules.backgroundVariable),
  );
  const foreground = opaqueColor(css.getPropertyValue(rules.textVariable));
  return background && foreground && background !== foreground
    ? { rules, view, background, foreground }
    : null;
}
function unreadCount(row: HTMLElement, selectors: UnreadSelectors) {
  const counts = new Set<number>();
  const visited = new Set<HTMLElement>();
  for (const selector of selectors.badge) {
    let badges: HTMLElement[];
    try {
      badges = [
        ...(row.matches(selector) ? [row] : []),
        ...row.querySelectorAll<HTMLElement>(selector),
      ];
    } catch {
      continue;
    }
    for (const badge of badges) {
      if (visited.has(badge) || !visibleBadge(badge)) continue;
      visited.add(badge);
      const label = badge.getAttribute('aria-label')?.trim() ?? '';
      const labelled =
        /^(\d{1,4})\s+unread messages?\.?$/i.exec(label)?.[1] ??
        /^unread messages?:?\s+(\d{1,4})$/i.exec(label)?.[1];
      // A compound row label must not mask a descendant's actual count.
      const number = labelled
        ? Number(labelled)
        : badge === row
          ? null
          : numericBadge(badge);
      if (number !== null) counts.add(number);
    }
  }
  if (counts.size) return counts.size === 1 ? [...counts][0]! : 0;
  const theme = badgeTheme(row, selectors);
  if (!theme) return 0;
  const title = select(row, selectors.title).element;
  for (const selector of theme.rules.candidate) {
    let badges: NodeListOf<HTMLElement>;
    try {
      badges = row.querySelectorAll<HTMLElement>(selector);
    } catch {
      continue;
    }
    if (badges.length > 64) continue;
    for (const badge of badges) {
      // Test styling before consulting text. Never read arbitrary numeric
      // previews, timestamps, titles or contact identifiers as unread counts.
      const css = theme.view.getComputedStyle(badge);
      if (
        opaqueColor(css.backgroundColor) !== theme.background ||
        opaqueColor(css.color) !== theme.foreground ||
        badge.matches('[title]') ||
        badge.contains(title) ||
        title?.contains(badge) ||
        badge.closest(
          'a, time, [contenteditable="true"], .selectable-text, .copyable-text',
        ) ||
        (badge.closest('button, [role="button"]') !== null &&
          !badge.closest('button, [role="button"]')?.contains(title)) ||
        badge.querySelector(
          '[title], a, button, time, img, svg, .selectable-text, .copyable-text',
        ) ||
        !visibleBadge(badge)
      )
        continue;
      const number = numericBadge(badge);
      if (number !== null) counts.add(number);
    }
  }
  return counts.size === 1 ? [...counts][0]! : 0;
}
function rowsIn(
  pane: HTMLElement,
  selectors: UnreadSelectors,
): Map<HTMLElement, HTMLElement> {
  const byTitle = new Map<HTMLElement, HTMLElement>();
  for (const selector of selectors.row) {
    try {
      for (const row of pane.querySelectorAll<HTMLElement>(selector)) {
        if (
          row.closest(
            '[hidden], [aria-hidden="true"], [role="menu"], [role="dialog"]',
          )
        )
          continue;
        const title = select(row, selectors.title).element;
        if (title && !byTitle.has(title)) byTitle.set(title, row);
      }
    } catch {
      /* Try the next configured selector. */
    }
  }
  return byTitle;
}
function attributeSelector(attribute: 'title' | 'data-chat-id', value: string) {
  const escaped =
    globalThis.CSS?.escape?.(value) ??
    (/^[\p{L}\p{N} ._+@:-]+$/u.test(value) ? value : undefined);
  return escaped === undefined ? null : `[${attribute}="${escaped}"]`;
}
const targetKey = (title: string, publicId?: string) =>
  publicId ? 'id:' + publicId : 'title:' + title;
// Only consult the row's timestamp control. A minute-only clock proves freshness
// when even the beginning of that minute falls within the observation window.
function rowTime(row: HTMLElement, selectors: UnreadSelectors, now: number) {
  const clock = select(row, selectors.time ?? ['time[datetime]']).element;
  if (!clock) return NaN;
  const datetime = clock.getAttribute('datetime');
  if (datetime && /^\d{4}-\d\d-\d\dT/.test(datetime))
    return Date.parse(datetime);
  const match = (datetime ?? clock.textContent ?? '')
    .trim()
    .match(/^(\d{1,2}):([0-5]\d)\s*(am|pm)?$/i);
  if (!match) return NaN;
  let hour = Number(match[1]);
  if (hour > 23 || (match[3] && (hour < 1 || hour > 12))) return NaN;
  if (match[3]) hour = (hour % 12) + (match[3].toLowerCase() === 'pm' ? 12 : 0);
  return new Date(now).setHours(hour, Number(match[2]), 0, 0);
}

// Only inspect a separator immediately before the advertised unread suffix.
// Walk up for virtualized list wrappers. Never extract a preceding bubble's text.
function hasBoundary(
  first: HTMLElement,
  list: HTMLElement,
  nodes: HTMLElement[],
  count: number,
  selectors: UnreadSelectors,
) {
  const earlier = nodes.slice(0, nodes.indexOf(first));
  for (
    let part: HTMLElement | null = first;
    part && part !== list;
    part = part.parentElement
  ) {
    if (earlier.some((node) => part?.contains(node))) return false;
    const previous = part.previousElementSibling;
    if (!previous) continue;
    if (
      nodes.some((row) => row === previous || previous.contains(row)) ||
      previous.matches('[data-id]') ||
      previous.querySelector(
        '[data-id], [data-pre-plain-text], .selectable-text',
      )
    )
      return false;
    const marker = matches(previous, selectors.divider)
      ? previous
      : select(previous, selectors.divider).element;
    // Plain WhatsApp layouts use a centered, single-label separator without a test ID.
    let leaf = marker ?? previous;
    for (
      let depth = 0;
      depth < 8 && leaf.childElementCount === 1 && leaf.firstElementChild;
      depth++
    )
      leaf = leaf.firstElementChild;
    const label =
      marker?.getAttribute('aria-label') ??
      (leaf.childElementCount === 0 ? leaf.textContent?.trim() : '');
    if (!label || label.length > 64) continue;
    const native = label.match(/^(\d+)\s+unread messages?$/i)?.[1];
    if (
      (native !== undefined && Number(native) === count) ||
      (Boolean(marker?.getAttribute('data-testid')?.includes('unread')) &&
        /^\d+$/.test(label) &&
        Number(label) === count)
    )
      return true;
  }
  return false;
}

/** Sidebar observation is limited to row handles, unread counts and the target
 * of a fresh badge change. No preview, contact inventory or inactive chat is read. */
export class UnreadInbox {
  private readonly selectors: UnreadSelectors;
  private pane: HTMLElement | null = null;
  private counts = new Map<HTMLElement, RowObservation>();
  // A short render-gap bridge, not a contact directory: no preview/body text,
  // only up to 32 just-detached, previously stable read-row handles.
  private detachedReadRows = new Map<HTMLElement, DetachedReadRow>();
  private readonly arrivals = new Map<string, Arrival>();
  private lastSkipReason: UnreadSkipReason | undefined;
  private initialSweep: boolean;
  private firstRowsAt: number | undefined;
  private stableRowsAt = 0;
  private waitingForDom = false;
  private blockedSince = 0;
  private lastVisibleListFound = false;
  private lastVisibleRows = 0;
  private lastVisibleUnreadRows = 0;
  get pendingCount() {
    return this.arrivals.size + Number(Boolean(this.opening));
  }
  get waitingForBackend() {
    const first = this.arrivals.values().next().value;
    return Boolean(
      !this.opening &&
      first?.backendOffline &&
      first.waitDeadline !== undefined &&
      Date.now() < first.waitDeadline,
    );
  }
  get initialSweepStarted() {
    return !this.initialSweep;
  }
  get diagnostics() {
    return {
      visible: this.document.visibilityState === 'visible',
      lastVisibleListFound: this.lastVisibleListFound,
      lastVisibleRows: Math.min(this.lastVisibleRows, 10000),
      lastVisibleUnreadRows: Math.min(this.lastVisibleUnreadRows, 10000),
      initialScanPending: this.initialSweep,
      existingUnreadQueued: Math.min(
        [...this.arrivals.values()].filter((entry) => entry.existing).length,
        10000,
      ),
      ...(this.lastSkipReason ? { lastSkipReason: this.lastSkipReason } : {}),
    };
  }
  private opening: Opening | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private watchSince = Date.now();
  private retryAt = 0;
  private stopped = false;
  private phase: 'WATCHING' | 'OPENING' | 'UNVERIFIED' = 'WATCHING';
  private documentAvailable() {
    return (
      this.document.visibilityState === 'visible' ||
      (this.config.enabled &&
        this.config.autoSendEnabled === true &&
        this.config.backgroundReplies === true)
    );
  }
  get status() {
    if (!this.pane || !this.documentAvailable()) return 'WAITING_FOR_LIST';
    if (this.initialSweep && !this.counts.size) return 'WAITING_FOR_LIST';
    if (this.initialSweep) return 'BASELINING';
    return Date.now() - this.watchSince < 600 ? 'BASELINING' : this.phase;
  }
  get openingChat() {
    return this.opening !== undefined;
  }
  constructor(
    private readonly document: Document,
    private readonly config: AdapterConfig,
    private readonly authorize: (request: AdapterRequest) => Promise<unknown>,
    private readonly wake: () => void,
    allowInitialSweep = true,
  ) {
    this.selectors = config.selectors.unread ?? defaultUnreadSelectors;
    this.initialSweep =
      allowInitialSweep && config.includeExistingUnread === true;
    this.observe([]);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    document.addEventListener('pointerdown', this.interrupt, true);
    document.addEventListener('keydown', this.interrupt, true);
  }
  private interrupt = (event: Event) => {
    if (
      event.isTrusted &&
      event.target instanceof Element &&
      (this.pane?.contains(event.target) ||
        event.target.closest('#main, [role="dialog"]'))
    ) {
      this.initialSweep = false;
      this.reset();
    }
  };
  private reset = () => {
    if (this.pane) this.initialSweep = false;
    this.arrivals.clear();
    this.detachedReadRows.clear();
    this.lastSkipReason = undefined;
    this.opening = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.phase = 'WATCHING';
    this.waitingForDom = false;
    this.blockedSince = 0;
    this.pane = null;
    this.observe([]);
  };
  private retainUnopenedExisting() {
    for (const [key, arrival] of this.arrivals) {
      // Invalidate a pending authorization as well as dropping live arrivals.
      // Existing candidates must obtain a new grant against the resumed view.
      if (arrival.existing) this.arrivals.set(key, { ...arrival });
      else this.arrivals.delete(key);
    }
    // A clicked row may already be marked read. Never enqueue it again.
    this.opening = undefined;
  }
  private retainUnopenedForPane() {
    for (const [key, arrival] of this.arrivals) {
      this.arrivals.set(key, {
        ...arrival,
        ...(!arrival.existing
          ? { paneDeadline: arrival.paneDeadline ?? Date.now() + 1000 }
          : {}),
      });
    }
    // Never put a clicked conversation back in the unread queue.
    this.opening = undefined;
  }
  private expireTransient() {
    for (const [row, entry] of this.detachedReadRows)
      if (Date.now() >= entry.expiresAt) this.detachedReadRows.delete(row);
    for (const [key, target] of this.arrivals) {
      if (
        target.paneDeadline !== undefined &&
        Date.now() >= target.paneDeadline
      ) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'ROW_UNVERIFIED';
      }
    }
  }
  private revalidatePaneCandidates() {
    if (!this.pane) return;
    for (const [key, target] of this.arrivals) {
      if (target.paneDeadline === undefined) continue;
      const replacement = this.owner(this.counts, target);
      // Partial pane rendering may not have returned this row yet. Keep only
      // the original bounded grace; a confirmed row no longer needs the grace.
      if (!replacement) continue;
      const originalHandles =
        replacement.row === target.row &&
        replacement.observation.titleNode === target.titleNode;
      const publicIdentity =
        target.publicId !== undefined &&
        this.uniquePublicId(target.publicId) &&
        !target.row.isConnected;
      if (
        replacement.observation.count !== target.count ||
        (!originalHandles && !publicIdentity) ||
        target.row.dataset.chatId !== target.publicId ||
        target.titleNode.getAttribute('title')?.trim() !== target.title
      ) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'ROW_UNVERIFIED';
        continue;
      }
      const restored = {
        ...target,
        row: replacement.row,
        titleNode: replacement.observation.titleNode,
      };
      delete restored.paneDeadline;
      this.arrivals.set(key, restored);
    }
  }
  private identityChanged(
    records: MutationRecord[],
    row: HTMLElement,
    title: HTMLElement,
  ) {
    return records.some(
      (record) =>
        ((record.target === title && record.attributeName === 'title') ||
          (record.target === row && record.attributeName === 'data-chat-id')) &&
        record.oldValue !==
          (record.target as Element).getAttribute(record.attributeName!),
    );
  }
  private visibilityChanged = () => {
    if (this.stopped) return;
    if (
      this.config.backgroundReplies &&
      this.config.enabled &&
      this.config.autoSendEnabled
    ) {
      // Switching browser tabs preserves the same live rendered-list boundary.
      this.observe([]);
      this.wake();
      return;
    }
    if (this.document.visibilityState !== 'visible') {
      this.retainUnopenedExisting();
      clearTimeout(this.timer);
      this.timer = undefined;
      this.pane = null;
      this.counts.clear();
      this.detachedReadRows.clear();
      this.firstRowsAt = undefined;
      this.waitingForDom = false;
      this.blockedSince = 0;
      this.phase = 'WATCHING';
    } else {
      // Rebaseline fresh arrivals, but revalidate the unfinished initial pass.
      this.observe([]);
    }
    this.wake();
  };
  dispose() {
    this.stopped = true;
    this.reset();
    this.document.removeEventListener(
      'visibilitychange',
      this.visibilityChanged,
    );
    this.document.removeEventListener('pointerdown', this.interrupt, true);
    this.document.removeEventListener('keydown', this.interrupt, true);
  }
  private tick(baseline = false) {
    if (
      this.stopped ||
      this.timer ||
      (!baseline &&
        !this.opening &&
        (!this.arrivals.size || this.waitingForDom) &&
        !this.detachedReadRows.size &&
        ![...this.arrivals.values()].some(
          (entry) => entry.paneDeadline !== undefined,
        ))
    )
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wake();
      },
      baseline ? 650 : 500,
    );
  }
  observe(records: MutationRecord[]) {
    if (this.stopped || !this.documentAvailable()) return;
    this.expireTransient();
    const chosen = select(this.document, this.selectors.pane).element;
    const pane = chosen?.closest('#pane-side, [data-testid="chat-list"]')
      ? chosen
      : null;
    this.lastVisibleListFound = Boolean(pane);
    const baseline = pane !== this.pane;
    if (baseline) {
      this.pane = pane;
      this.counts.clear();
      this.detachedReadRows.clear();
      this.retainUnopenedForPane();
      this.watchSince = Date.now();
      this.firstRowsAt = undefined;
      this.phase = 'WATCHING';
      if (pane) this.tick(true);
    }
    if (!pane) {
      this.lastVisibleRows = 0;
      this.lastVisibleUnreadRows = 0;
    }
    if (this.opening && this.destination(this.opening.arrival)) {
      const list = select(
        this.document,
        this.config.selectors.messageList,
      ).element;
      if (list) this.capture(list, this.opening);
    }
    if (
      !pane ||
      (!baseline && !records.some((record) => pane.contains(record.target)))
    )
      return;
    const oldCounts = this.counts;
    this.counts = new Map();
    const now = Date.now();
    const changedIdentity = (row: HTMLElement, title: HTMLElement) =>
      this.identityChanged(records, row, title);
    for (const [row, entry] of this.detachedReadRows)
      if (changedIdentity(row, entry.observation.titleNode))
        this.detachedReadRows.delete(row);
    for (const [key, queued] of this.arrivals) {
      if (changedIdentity(queued.row, queued.titleNode)) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'ROW_UNVERIFIED';
      }
    }
    for (const [titleNode, row] of rowsIn(pane, this.selectors)) {
      const count = unreadCount(row, this.selectors);
      const previous = oldCounts.get(row);
      const stable =
        previous?.titleNode === titleNode && !changedIdentity(row, titleNode);
      const since = previous && stable ? previous.since : now;
      this.counts.set(row, { count, titleNode, since });
    }
    this.lastVisibleRows = this.counts.size;
    this.lastVisibleUnreadRows = [...this.counts.values()].filter(
      ({ count }) => count > 0,
    ).length;
    this.revalidatePaneCandidates();
    for (const [row, observation] of oldCounts) {
      if (
        this.detachedReadRows.size >= 32 ||
        this.counts.has(row) ||
        row.isConnected ||
        observation.count !== 0 ||
        now - observation.since < 600 ||
        !row.contains(observation.titleNode) ||
        changedIdentity(row, observation.titleNode)
      )
        continue;
      const title = observation.titleNode.getAttribute('title')?.trim();
      if (!title || title.length > 200) continue;
      this.detachedReadRows.set(row, {
        row,
        observation,
        title,
        publicId: row.dataset.chatId,
        expiresAt: now + 1000,
      });
    }
    // Start the quiet interval at the first actual rows. The pane itself may
    // have existed for seconds before WhatsApp renders rows and unread badges.
    if (this.initialSweep) {
      if (this.counts.size === 0) {
        this.firstRowsAt = undefined;
        return;
      }
      const changed =
        this.counts.size !== oldCounts.size ||
        [...this.counts].some(([row, observed]) => {
          const prior = oldCounts.get(row);
          return (
            prior?.count !== observed.count ||
            prior.titleNode !== observed.titleNode
          );
        });
      if (this.firstRowsAt === undefined || changed) {
        this.firstRowsAt ??= now;
        // Constant sidebar activity must not defer the snapshot forever.
        this.stableRowsAt = Math.min(now + 600, this.firstRowsAt + 5000);
      }
      this.tick(true);
      return;
    }
    if (baseline) return;
    for (const [key, queued] of this.arrivals) {
      if (this.counts.get(queued.row)?.count === 0 && this.attached(queued))
        this.arrivals.delete(key);
    }
    for (const [row, current] of this.counts) {
      const { count, titleNode } = current;
      const previous = oldCounts.get(row);
      const stable =
        previous?.titleNode === titleNode && !changedIdentity(row, titleNode);
      if (!count || (previous && stable && count <= previous.count)) continue;
      if (changedIdentity(row, titleNode)) {
        this.lastSkipReason = 'ROW_UNVERIFIED';
        continue;
      }
      const target = this.describe(row, current, false, now);
      if (!target || this.owner(this.counts, target)?.row !== row) {
        this.lastSkipReason = 'ROW_UNVERIFIED';
        continue;
      }
      const key = targetKey(target.title, target.publicId);
      const queued = this.arrivals.get(key);
      // A row can be replaced again while another chat is generating a reply.
      // Preserve the original arrival time and queue position, including a
      // pending initial unread, without treating the remount as a new message.
      if (
        queued &&
        queued.count === count &&
        this.owner(this.counts, target)?.row === row
      ) {
        // Pane remounts have a stricter proof check in advance(), before a
        // replacement can overwrite the original row/title handles.
        if (
          !queued.paneDeadline &&
          (queued.row !== row || queued.titleNode !== titleNode)
        )
          this.arrivals.set(key, { ...queued, row, titleNode });
        continue;
      }
      const old =
        stable && previous
          ? { row, observation: previous }
          : (this.owner(oldCounts, target) ??
            this.detachedOwner(target, records));
      const linked =
        old &&
        !changedIdentity(old.row, old.observation.titleNode) &&
        (old.row === row || !pane.contains(old.row)) &&
        this.owner(this.counts, target)?.row === row;
      if (linked && count <= old.observation.count) continue;
      let observedAt = now;
      if (!linked || now - old.observation.since < 600) {
        // Mounting an old unread row (scroll, search, first paint) is not an
        // arrival. A new row needs independent public timestamp evidence.
        const time = rowTime(row, this.selectors, now);
        if (!(
          time >= this.watchSince &&
          time <= now &&
          now - time < this.freshness
        )) {
          this.lastSkipReason = 'NO_FRESH_ARRIVAL';
          continue;
        }
        observedAt = time;
      }
      if (
        !queued &&
        this.arrivals.size >= 32 &&
        [...this.arrivals.values()].filter((entry) => !entry.existing).length >=
          32
      )
        continue;
      this.arrivals.set(key, { ...target, at: observedAt });
      this.lastSkipReason = undefined;
      if (old) this.detachedReadRows.delete(old.row);
    }
    this.tick();
  }
  private describe(
    row: HTMLElement,
    observation: RowObservation,
    existing: boolean,
    at: number,
  ): Arrival | null {
    if (!observation.count) return null;
    const title = observation.titleNode.getAttribute('title')?.trim();
    return title && title.length <= 200
      ? {
          row,
          titleNode: observation.titleNode,
          title,
          publicId: row.dataset.chatId,
          count: observation.count,
          existing,
          at,
        }
      : null;
  }
  private owner(snapshot: Map<HTMLElement, RowObservation>, target: Arrival) {
    if (
      target.publicId &&
      [...snapshot.keys()].filter(
        (row) => row.dataset.chatId === target.publicId,
      ).length !== 1
    )
      return undefined;
    const title = attributeSelector('title', target.title);
    const id = target.publicId
      ? attributeSelector('data-chat-id', target.publicId)
      : null;
    if (!title || (target.publicId && !id)) return undefined;
    let match: { row: HTMLElement; observation: RowObservation } | undefined;
    // Match the candidate only; never collect a directory of chat names or IDs.
    for (const [row, observation] of snapshot) {
      if (!observation.titleNode.matches(title) || (id && !row.matches(id)))
        continue;
      if (match) return undefined;
      match = { row, observation };
    }
    return match;
  }
  private uniquePublicId(publicId: string) {
    return (
      [...this.counts.keys()].filter((row) => row.dataset.chatId === publicId)
        .length === 1
    );
  }
  private detachedOwner(target: Arrival, records: MutationRecord[]) {
    const matches = [...this.detachedReadRows.values()].filter(
      (entry) =>
        entry.title === target.title &&
        entry.publicId === target.publicId &&
        entry.row.dataset.chatId === entry.publicId &&
        entry.observation.titleNode.getAttribute('title')?.trim() ===
          entry.title &&
        entry.row.contains(entry.observation.titleNode) &&
        !this.identityChanged(
          records,
          entry.row,
          entry.observation.titleNode,
        ) &&
        ((entry.row === target.row &&
          entry.observation.titleNode === target.titleNode) ||
          (Boolean(target.publicId) &&
            !entry.row.isConnected &&
            this.uniquePublicId(target.publicId!))),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  private seedVisibleUnread() {
    if (!this.initialSweep || !this.pane || !this.counts.size) return;
    if (Date.now() < this.stableRowsAt) {
      this.tick(true);
      return;
    }
    this.initialSweep = false;
    for (const [row, observation] of this.counts) {
      const target = this.describe(row, observation, true, Date.now());
      if (target && this.owner(this.counts, target)?.row === row) {
        this.arrivals.set(targetKey(target.title, target.publicId), target);
        this.lastSkipReason = undefined;
      } else if (observation.count) this.lastSkipReason = 'ROW_UNVERIFIED';
    }
  }
  private get freshness() {
    return Math.min(this.config.duplicateWindowSeconds, 300) * 1000;
  }
  private attached(target: Arrival) {
    return (
      this.pane?.contains(target.row) &&
      target.row.isConnected &&
      target.row.dataset.chatId === target.publicId &&
      select(target.row, this.selectors.title)
        .element?.getAttribute('title')
        ?.trim() === target.title
    );
  }
  private uniqueTitle(target: Arrival) {
    return this.owner(this.counts, target)?.row === target.row;
  }
  private destination(target: Arrival) {
    if (readChatTitle(this.document, this.config) !== target.title)
      return false;
    if (target.publicId)
      return chatIdentity(this.document, this.config).value === target.publicId;
    const actual = this.owner(this.counts, target)?.row;
    if (!actual || !this.pane?.contains(actual)) return false;
    // A remounted title-only target requires positive native selection.
    if (
      actual.matches('[aria-selected="true"]') ||
      actual.querySelector('[aria-selected="true"]')
    )
      return true;
    if (actual !== target.row || !this.attached(target)) return false;
    if (
      target.row.matches('[aria-selected="false"]') ||
      target.row.querySelector('[aria-selected="false"]')
    )
      return false;
    // Some layouts do not expose selection. Require a unique exact sidebar title.
    return true;
  }
  async advance(view: OpenChat) {
    if (this.stopped || !this.documentAvailable()) return;
    this.expireTransient();
    this.revalidatePaneCandidates();
    if (!this.pane) {
      if (
        [...this.arrivals.values()].some(
          (entry) => entry.paneDeadline !== undefined,
        )
      )
        this.tick();
      return;
    }
    try {
      this.seedVisibleUnread();
      if (this.opening) {
        await this.confirm(view, this.opening);
        return;
      }
      const entry = this.arrivals.entries().next().value;
      if (!entry) return;
      const [key, original] = entry;
      if (
        original.waitDeadline !== undefined &&
        Date.now() >= original.waitDeadline
      ) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'SOURCE_EXPIRED';
        return;
      }
      let target = original;
      if (target.paneDeadline !== undefined) {
        return;
      }
      if (!this.attached(target)) {
        const replacement = this.owner(this.counts, target);
        if (replacement?.observation.count === target.count) {
          target = {
            ...target,
            row: replacement.row,
            titleNode: replacement.observation.titleNode,
          };
          delete target.missingSince;
          this.arrivals.set(key, target);
        } else if (!target.row.isConnected && !replacement) {
          // A removal and its replacement can occur in separate render tasks.
          target.missingSince ??= Date.now();
          if (Date.now() - target.missingSince < 1000) return;
        }
      }
      if (
        !this.attached(target) ||
        (!target.publicId && !this.uniqueTitle(target)) ||
        (!target.existing && Date.now() - target.at >= this.freshness) ||
        unreadCount(target.row, this.selectors) !== target.count ||
        readChatTitle(this.document, this.config) === target.title
      ) {
        this.arrivals.delete(key);
        this.lastSkipReason =
          !target.existing && Date.now() - target.at >= this.freshness
            ? 'SOURCE_EXPIRED'
            : 'ROW_UNVERIFIED';
        return;
      }
      if (!view.canLeave()) {
        this.blockedSince ||= Date.now();
        this.waitingForDom = Date.now() - this.blockedSince >= this.freshness;
        return;
      }
      this.blockedSince = 0;
      this.waitingForDom = false;
      if (Date.now() < this.retryAt) return;
      const scoped = (value: string) =>
        hash(`${this.config.salt}:${this.config.profileId}:${value}`);
      const titleKey = await scoped(target.title);
      const targetKey = target.publicId
        ? await scoped(target.publicId)
        : undefined;
      const observedAt = target.existing ? Date.now() : target.at;
      const decision = UnreadOpenResultSchema.safeParse(
        await this.authorize({
          version: 1,
          type: 'ADAPTER_OPEN_UNREAD',
          profileId: this.config.profileId,
          fromContextId: view.context?.contextId ?? null,
          titleKey,
          ...(targetKey ? { targetKey } : {}),
          observedAt,
          ...(target.existing ? { existingUnread: true } : {}),
        }),
      );
      if (this.arrivals.get(key) !== target || this.stopped) return;
      // Existing-unread requests refresh their observation time at dispatch;
      // a separate deadline must survive retries and row remounts.
      if (
        target.waitDeadline !== undefined &&
        Date.now() >= target.waitDeadline
      ) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'SOURCE_EXPIRED';
        return;
      }
      if (decision.success && decision.data.state === 'WAIT') {
        if (
          decision.data.reason === 'BACKEND_OFFLINE' ||
          decision.data.reason === 'POLICY_CHANGED'
        ) {
          target.backendOffline = decision.data.reason === 'BACKEND_OFFLINE';
          target.waitDeadline ??= Math.min(
            Date.now() + Math.min(60000, this.freshness),
            target.existing ? Infinity : target.at + this.freshness,
          );
          this.retryAt = Math.min(
            Date.now() + (target.backendOffline ? 2000 : 500),
            target.waitDeadline,
          );
        } else {
          target.backendOffline = false;
          this.retryAt = Date.now() + 500;
        }
        return;
      }
      if (!decision.success || decision.data.state !== 'OPEN') {
        this.arrivals.delete(key);
        this.lastSkipReason =
          decision.success && decision.data.state === 'SKIP'
            ? decision.data.reason
            : 'ROW_UNVERIFIED';
        return;
      }
      if (
        !view.canLeave() ||
        !this.attached(target) ||
        (!target.publicId && !this.uniqueTitle(target)) ||
        !this.documentAvailable() ||
        unreadCount(target.row, this.selectors) !== target.count ||
        Date.now() - observedAt >= this.freshness
      )
        return;
      const clickable = select(target.row, this.selectors.title).element;
      const button = clickable?.closest('button, [role="button"]');
      if (button && !(button instanceof HTMLElement)) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'ROW_UNVERIFIED';
        return;
      }
      if (
        !clickable ||
        clickable.closest('a, input, [role="menu"], [role="dialog"]') ||
        (button &&
          button !== target.row &&
          !button.contains(target.row) &&
          unreadCount(button, this.selectors) !== target.count)
      ) {
        this.arrivals.delete(key);
        this.lastSkipReason = 'ROW_UNVERIFIED';
        return;
      }
      const priorList = view.list;
      const priorNodes = priorList
        ? messageNodes(priorList, this.config.selectors)
        : [];
      this.arrivals.delete(key);
      this.lastSkipReason = undefined;
      this.opening = {
        arrival: { ...target, at: observedAt },
        grantId: decision.data.grantId,
        fromContextId: view.context?.contextId ?? null,
        deadline: Math.min(observedAt + this.freshness, Date.now() + 8000),
        priorNodes: new WeakSet(priorNodes),
        priorIds: new Set(
          priorList
            ? priorNodes
                .map((node) => messageDomId(node, priorList))
                .filter((id) => id !== null)
            : [],
        ),
      };
      this.phase = 'OPENING';
      // WhatsApp layouts can open rows on mouse-down or click. Complete a
      // single gesture on the rechecked title, never on a neighbouring control.
      clickable.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
        }),
      );
      if (clickable.isConnected) {
        clickable.dispatchEvent(
          new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        if (
          !this.destination(target) &&
          this.attached(target) &&
          view.canLeave()
        )
          clickable.click();
      }
    } finally {
      this.tick();
    }
  }
  private capture(list: HTMLElement, open: Opening) {
    const nodes = messageNodes(list, this.config.selectors);
    const tail = nodes.at(-1);
    const first = nodes.at(-open.arrival.count);
    if (
      !tail ||
      !first ||
      open.priorNodes.has(tail) ||
      messageDirection(tail, this.config.selectors) !== 'incoming'
    )
      return;
    const id = messageDomId(tail, list);
    if (
      !id ||
      open.priorIds.has(id) ||
      nodes.filter((node) => messageDomId(node, list) === id).length !== 1
    )
      return;
    // A later unsupported media row may have a public ID even if direction
    // selectors do not recognize it. Never answer the older text above it.
    const lastIdentified = list.querySelectorAll('[data-id]');
    const last = lastIdentified.item(lastIdentified.length - 1);
    if (
      last &&
      !tail.contains(last) &&
      !last.contains(tail) &&
      tail.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING
    )
      return;
    if (hasBoundary(first, list, nodes, open.arrival.count, this.selectors))
      open.proof = { id, list };
    return open.proof?.id === id && open.proof.list === list
      ? { tail, id }
      : undefined;
  }
  private async confirm(view: OpenChat, open: Opening) {
    const { context, list } = view;
    if (Date.now() >= open.deadline) {
      this.opening = undefined;
      this.phase = 'UNVERIFIED';
      this.lastSkipReason = 'ROW_UNVERIFIED';
      return;
    }
    if (
      !context ||
      !list ||
      context.contextId === open.fromContextId ||
      !this.destination(open.arrival)
    )
      return;
    const captured = this.capture(list, open);
    if (!captured || !view.ready || !view.canLeave()) return;
    const { tail, id } = captured;
    // The native divider may have disappeared on read. Only the same proven
    // public tail ID can cross the hydration baseline, exactly once per click.
    const valid = () =>
      this.opening === open &&
      Date.now() < open.deadline &&
      this.destination(open.arrival) &&
      messageDomId(tail, list) === id &&
      messageNodes(list, this.config.selectors).at(-1) === tail;
    const accepted = await view.publish(
      tail,
      open.grantId,
      open.arrival.at,
      valid,
    );
    if (this.opening === open) {
      this.opening = undefined;
      this.phase = accepted ? 'WATCHING' : 'UNVERIFIED';
      if (!accepted) this.lastSkipReason = 'ROW_UNVERIFIED';
    }
  }
}
