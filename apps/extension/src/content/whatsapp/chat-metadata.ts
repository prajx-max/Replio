import type { AdapterConfig } from '@assistant/contracts';
import { select } from './selector-registry.js';

export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}
export function readChatTitle(
  document: Document,
  config: AdapterConfig,
): string {
  const header = select(document, config.selectors.chatHeader).element;
  return (header?.getAttribute('title') ?? header?.textContent ?? '')
    .trim()
    .slice(0, 200);
}
export function labelFor(title: string): string {
  return title
    .replace(
      /\+?\d[\d\s()-]{5,}\d/g,
      (value) => `••••${value.replace(/\D/g, '').slice(-4)}`,
    )
    .slice(0, 120);
}
export function chatIdentity(
  document: Document,
  config: AdapterConfig,
): { value: string; strong: boolean } {
  const header = select(document, config.selectors.chatHeader).element;
  const explicit =
    header?.getAttribute('data-chat-id') ??
    header?.closest('[data-chat-id]')?.getAttribute('data-chat-id');
  if (explicit) return { value: explicit, strong: true };
  const list = select(document, config.selectors.messageList).element;
  for (const node of [
    ...(list?.querySelectorAll<HTMLElement>('[data-id]') ?? []),
  ].slice(0, 20)) {
    const id = node
      .getAttribute('data-id')
      ?.match(
        /^(?:true|false)_([^_]+@(?:c\.us|g\.us|lid|s\.whatsapp\.net))_/u,
      )?.[1];
    if (id) return { value: id, strong: true };
  }
  return { value: readChatTitle(document, config), strong: false };
}
