import { AdapterStructureSchema } from '@assistant/contracts';
import type { AdapterConfig, AdapterStructure } from '@assistant/contracts';
import { select } from './selector-registry.js';
import { messageNodes } from './reader.js';
import { messageDirection } from './direction.js';

function elements(root: ParentNode | null, selectors: string[]): HTMLElement[] {
  const nodes = new Set<HTMLElement>();
  for (const selector of selectors) {
    try {
      for (const node of root?.querySelectorAll<HTMLElement>(selector) ?? [])
        nodes.add(node);
    } catch {
      /* Imported CSS is data; malformed selectors cannot execute code. */
    }
  }
  return [...nodes];
}
const roles = new Set([
  'row',
  'gridcell',
  'grid',
  'list',
  'listitem',
  'application',
  'log',
  'textbox',
]);
// Export only recognizable structural tokens, never arbitrary class values.
const structuralClass =
  /^(?:message-in|message-out|copyable-text|selectable-text|x[a-z0-9]{1,20}|_[a-z][a-z0-9_]{1,20})$/;
export function inspectStructure(
  document: Document,
  config: AdapterConfig,
): AdapterStructure {
  const pack = config.selectors;
  const main = select(document, pack.appShell).element;
  const list = select(document, pack.messageList).element;
  const composer = select(document, pack.composer).element;
  const directions = list
    ? messageNodes(list, pack).map((node) => messageDirection(node, pack))
    : [];
  const text = elements(main, pack.messageText).filter(
    (node) => !node.closest('header, footer, [contenteditable="true"]'),
  );
  const samples = text.slice(-3).map((node) => {
    const chain = [];
    let current: HTMLElement | null = node;
    while (current && current !== main && chain.length < 8) {
      const role = current.getAttribute('role');
      const id = current.getAttribute('data-id');
      chain.push({
        tag: current.tagName.toLowerCase().slice(0, 20),
        role: role === null ? 'none' : roles.has(role) ? role : 'other',
        attributes: current
          .getAttributeNames()
          .filter((name) => /^data-[a-z-]{1,40}$/.test(name))
          .slice(0, 20),
        idFormat:
          id === null
            ? 'missing'
            : id.startsWith('false_')
              ? 'incoming-prefix'
              : id.startsWith('true_')
                ? 'outgoing-prefix'
                : 'other',
        classes: [...current.classList]
          .filter((name) => structuralClass.test(name) && !/\d{5}/.test(name))
          .slice(0, 12),
      });
      current = current.parentElement;
    }
    return chain;
  });
  return AdapterStructureSchema.parse({
    buildVersion: config.buildVersion ?? 'unknown',
    selectorVersion: pack.version,
    enabled: config.enabled,
    autoSendEnabled: config.autoSendEnabled === true,
    backgroundReplies: config.backgroundReplies === true,
    visibilityState: document.visibilityState,
    textNodesInList: Math.min(10000, elements(list, pack.messageText).length),
    textNodesInMain: Math.min(10000, text.length),
    incomingNodesInList: Math.min(
      10000,
      directions.filter((direction) => direction === 'incoming').length,
    ),
    outgoingNodesInList: Math.min(
      10000,
      directions.filter((direction) => direction === 'outgoing').length,
    ),
    listContainsComposer: Boolean(list && composer && list.contains(composer)),
    samples,
  });
}
