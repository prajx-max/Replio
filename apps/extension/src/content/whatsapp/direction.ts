import type { SelectorPack } from '@assistant/contracts';
import { matches, select } from './selector-registry.js';

export type MessageDirection = 'incoming' | 'outgoing' | 'unknown';

// Match opaque CSS theme colors, not hard-coded light/dark colors or position.
// Unsupported, translucent, or equal theme values fail closed.
export function opaqueColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex;
    return [0, 2, 4]
      .map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16))
      .join(',');
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text)?.[1];
  if (!rgb) return null;
  const parts = rgb
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  if (
    (parts.length !== 3 && parts.length !== 4) ||
    parts.some((part) => !Number.isFinite(part)) ||
    (parts[3] !== undefined && parts[3] !== 1)
  )
    return null;
  const channels = parts.slice(0, 3);
  return channels.every((part) => part >= 0 && part <= 255)
    ? channels.join(',')
    : null;
}

export function messageDirection(
  node: HTMLElement,
  pack: SelectorPack,
): MessageDirection {
  const incoming = matches(node, pack.incomingMessage);
  const outgoing = matches(node, pack.outgoingMessage);
  if (incoming || outgoing)
    return incoming === outgoing
      ? 'unknown'
      : incoming
        ? 'incoming'
        : 'outgoing';
  const rules = pack.themeDirection;
  if (!rules || !matches(node, [rules.row])) return 'unknown';
  const document = node.ownerDocument;
  const view = document.defaultView;
  const main = select(document, pack.appShell).element;
  if (!view || !main?.contains(node)) return 'unknown';
  const theme = view.getComputedStyle(main);
  const incomingColor = opaqueColor(
    theme.getPropertyValue(rules.incomingVariable),
  );
  const outgoingColor = opaqueColor(
    theme.getPropertyValue(rules.outgoingVariable),
  );
  if (!incomingColor || !outgoingColor || incomingColor === outgoingColor)
    return 'unknown';
  const found = new Set<MessageDirection>();
  try {
    for (const bubble of [
      ...node.querySelectorAll<HTMLElement>(rules.bubble),
    ].slice(0, 16)) {
      // A quoted/nested message is not the current row's own bubble.
      if (bubble.closest(rules.row) !== node) continue;
      const background = opaqueColor(
        view.getComputedStyle(bubble).backgroundColor,
      );
      if (background === incomingColor) found.add('incoming');
      if (background === outgoingColor) found.add('outgoing');
    }
  } catch {
    return 'unknown';
  }
  return found.size === 1
    ? (found.values().next().value ?? 'unknown')
    : 'unknown';
}
