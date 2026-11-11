import type { AdapterConfig } from '@assistant/contracts';
import { select } from './selector-registry.js';

const normalizeText = (text: string) =>
  text.replaceAll('\u00a0', ' ').replace(/\r\n?/g, '\n').trim();

/** Composer-only text; preserve paragraph/BR boundaries and emoji alt text.
 * Never collapse words, internal whitespace, identifiers or punctuation. */
export function composerText(element: HTMLElement): string | null {
  let budget = 10000;
  function read(node: Node, depth: number): string | null {
    if (--budget < 0 || depth > 40) return null;
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node instanceof Element && node.tagName === 'BR') return '\n';
    if (node instanceof Element && node.tagName === 'IMG')
      return node.getAttribute('alt')?.trim() ? node.getAttribute('alt') : null;
    let result = '';
    for (const child of node.childNodes) {
      const text = read(child, depth + 1);
      if (text === null) return null;
      const block =
        child instanceof Element && /^(DIV|P|LI)$/.test(child.tagName);
      if (block && result && !result.endsWith('\n')) result += '\n';
      result += text;
      if (block && !result.endsWith('\n')) result += '\n';
    }
    return result;
  }
  const text = read(element, 0);
  return text === null ? null : normalizeText(text);
}

/** Own only text written into an empty editor in this footer. Equivalent editor
 * remounts may be followed; trusted editing or a changed footer cancels it. */
export class ComposerInsertion {
  private inserting = false;
  private edited = false;
  private readonly footer: HTMLElement | null;
  private readonly expected: string;
  private readonly events = [
    'beforeinput',
    'input',
    'keydown',
    'paste',
    'drop',
    'pointerdown',
  ] as const;
  private readonly observe = (event: Event) => {
    if (
      !this.inserting &&
      event.isTrusted &&
      event.target instanceof Node &&
      this.footer?.contains(event.target)
    )
      this.edited = true;
  };
  constructor(
    private readonly document: Document,
    private readonly config: AdapterConfig,
    private readonly text: string,
  ) {
    this.footer =
      select(document, config.selectors.composer).element?.closest('footer') ??
      null;
    this.expected = normalizeText(text);
  }
  get element(): HTMLElement | null {
    const element = select(
      this.document,
      this.config.selectors.composer,
    ).element;
    return this.footer?.isConnected &&
      this.footer.closest('#main') &&
      element?.getAttribute('contenteditable') === 'true' &&
      this.footer.contains(element)
      ? element
      : null;
  }
  get attached() {
    return this.footer?.isConnected === true;
  }
  get interrupted() {
    return this.edited || !this.attached;
  }
  insert(): boolean {
    const element = this.element;
    if (!element || composerText(element) !== '') return false;
    for (const name of this.events)
      this.document.addEventListener(name, this.observe, true);
    this.inserting = true;
    try {
      element.focus();
      const selection = this.document.getSelection();
      const range = this.document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return this.document.execCommand('insertText', false, this.text);
    } finally {
      this.inserting = false;
    }
  }
  matches(): boolean {
    const element = this.element;
    return (
      !this.edited &&
      element !== null &&
      composerText(element) === this.expected
    );
  }
  cleared(): boolean {
    const element = this.element;
    return element !== null && composerText(element) === '';
  }
  dispose() {
    for (const name of this.events)
      this.document.removeEventListener(name, this.observe, true);
  }
}

export function insertDraft(
  document: Document,
  config: AdapterConfig,
  text: string,
): boolean {
  const insertion = new ComposerInsertion(document, config, text);
  try {
    return insertion.insert() && insertion.matches();
  } finally {
    insertion.dispose();
  }
}
