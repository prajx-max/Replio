import { selectorNames } from '@assistant/contracts';
import type { SelectorPack, AdapterStatus } from '@assistant/contracts';
import { select } from './selector-registry.js';
import { messageNodes } from './reader.js';
import { messageDirection } from './direction.js';

export function diagnostics(
  document: Document,
  pack: SelectorPack,
): AdapterStatus['matches'] {
  const result = Object.fromEntries(
    selectorNames.map((name) => [name, select(document, pack[name]).index]),
  ) as AdapterStatus['matches'];
  const list = select(document, pack.messageList).element;
  if (list && pack.themeDirection) {
    const directions = new Set(
      messageNodes(list, pack).map((node) => messageDirection(node, pack)),
    );
    if (result.incomingMessage < 0 && directions.has('incoming'))
      result.incomingMessage = Math.min(7, pack.incomingMessage.length);
    if (result.outgoingMessage < 0 && directions.has('outgoing'))
      result.outgoingMessage = Math.min(7, pack.outgoingMessage.length);
  }
  return result;
}
