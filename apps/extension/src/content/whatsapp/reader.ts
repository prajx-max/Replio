import type { SelectorPack } from '@assistant/contracts';
import { messageDirection } from './direction.js';

export function messageNodes(
  list: HTMLElement,
  pack: SelectorPack,
): HTMLElement[] {
  const selectors = [
    ...pack.incomingMessage,
    ...pack.outgoingMessage,
    ...(pack.themeDirection ? [pack.themeDirection.row] : []),
  ];
  const nodes = new Set<HTMLElement>();
  for (const selector of selectors) {
    try {
      for (const node of list.querySelectorAll<HTMLElement>(selector))
        nodes.add(node);
    } catch {
      /* Diagnostics report unmatched malformed selectors. */
    }
  }
  // Public-ID wrappers can contain legacy class wrappers. Choose the outer
  // message once, so an outgoing bubble cannot expose a nested quoted message
  // as incoming and the same message is not processed twice.
  const messages = [...nodes].filter((node) => {
    let parent = node.parentElement;
    while (parent && parent !== list) {
      if (nodes.has(parent)) return false;
      parent = parent.parentElement;
    }
    return true;
  });
  return messages.sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1,
  );
}
export function incomingText(
  node: HTMLElement,
  pack: SelectorPack,
): string | null {
  if (messageDirection(node, pack) !== 'incoming') return null;
  for (const selector of pack.messageText) {
    try {
      const candidates = [...node.querySelectorAll<HTMLElement>(selector)];
      const text = candidates.at(-1)?.textContent?.trim();
      if (text && text.length <= 16000) return text;
    } catch {
      /* Use the next fallback. */
    }
  }
  return null;
}
export function messageDomId(
  node: HTMLElement,
  list: HTMLElement,
): string | null {
  const candidate = node.hasAttribute('data-id')
    ? node
    : node.closest<HTMLElement>('[data-id]');
  return candidate && candidate !== list && list.contains(candidate)
    ? candidate.getAttribute('data-id')
    : null;
}
