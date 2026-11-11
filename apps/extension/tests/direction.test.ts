// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { defaultSelectors } from '@assistant/contracts';
import { messageDirection } from '../src/content/whatsapp/direction.js';
import { incomingText, messageNodes } from '../src/content/whatsapp/reader.js';
import { diagnostics } from '../src/content/whatsapp/diagnostics.js';

function setup(incoming = '#242626', outgoing = '#144d37', bubble = incoming) {
  document.body.innerHTML = `<main id="main"><div data-testid="conversation-panel-messages"><div data-testid="conv-msg-fixture" data-id="ABCDEF123456"><div data-testid="msg-container"><div><div data-pre-plain-text="private sender"><span class="selectable-text copyable-text">New fixture question</span></div></div></div></div></div></main>`;
  const main = document.querySelector<HTMLElement>('#main');
  const row = document.querySelector<HTMLElement>(
    '[data-testid="conv-msg-fixture"]',
  );
  const content = document.querySelector<HTMLElement>(
    '[data-testid="msg-container"] > div',
  );
  if (!main || !row || !content) throw new Error('Missing synthetic layout');
  main.style.setProperty('--incoming-background', incoming);
  main.style.setProperty('--outgoing-background', outgoing);
  content.style.backgroundColor = bubble;
  return { main, row, content };
}
describe('observed WhatsApp theme direction fallback', () => {
  it.each([
    ['#242626', '#144d37'],
    ['#ffffff', '#d9fdd3'],
    ['rgb(36, 38, 38)', 'rgb(20, 77, 55)'],
  ])(
    'recognizes distinct theme colors %s/%s, independent of language or side',
    (incoming, outgoing) => {
      const { row, content, main } = setup(incoming, outgoing);
      main.dir = 'rtl';
      expect(messageDirection(row, defaultSelectors)).toBe('incoming');
      expect(incomingText(row, defaultSelectors)).toBe('New fixture question');
      expect(diagnostics(document, defaultSelectors).incomingMessage).toBe(3);
      content.style.backgroundColor = outgoing;
      expect(messageDirection(row, defaultSelectors)).toBe('outgoing');
      expect(incomingText(row, defaultSelectors)).toBeNull();
    },
  );
  it.each(['', 'transparent', '#242626'])(
    'rejects missing, transparent or equal direction variables: %s',
    (outgoing) => {
      const { row } = setup('#242626', outgoing);
      expect(messageDirection(row, defaultSelectors)).toBe('unknown');
      expect(incomingText(row, defaultSelectors)).toBeNull();
    },
  );
  it('does not infer incoming from an unmatched or translucent bubble', () => {
    const { row, content } = setup('#242626', '#144d37', '#ff0000');
    expect(messageDirection(row, defaultSelectors)).toBe('unknown');
    content.style.backgroundColor = 'rgba(36, 38, 38, 0.5)';
    expect(messageDirection(row, defaultSelectors)).toBe('unknown');
  });
  it('rejects conflicting same-row bubbles and ignores nested quoted row colors', () => {
    const { row, content } = setup();
    const container = content.parentElement;
    if (!container) throw new Error('Missing container');
    const sibling = document.createElement('div');
    sibling.style.backgroundColor = '#144d37';
    container.append(sibling);
    expect(messageDirection(row, defaultSelectors)).toBe('unknown');
    sibling.remove();
    content.style.backgroundColor = '#144d37';
    content.innerHTML =
      '<div data-testid="conv-msg-quoted"><div data-testid="msg-container"><div style="background-color:#242626"><span class="selectable-text copyable-text">Quoted incoming text</span></div></div></div>';
    expect(messageDirection(row, defaultSelectors)).toBe('outgoing');
    expect(incomingText(row, defaultSelectors)).toBeNull();
    const list = document.querySelector<HTMLElement>(
      '[data-testid="conversation-panel-messages"]',
    );
    if (!list) throw new Error('Missing list');
    expect(messageNodes(list, defaultSelectors)).toEqual([row]);
  });
  it('never applies the theme heuristic to arbitrary matching colors or outside the active main', () => {
    const { row, main } = setup();
    row.removeAttribute('data-testid');
    expect(messageDirection(row, defaultSelectors)).toBe('unknown');
    row.dataset.testid = 'conv-msg-fixture';
    main.removeAttribute('id');
    expect(messageDirection(row, defaultSelectors)).toBe('unknown');
  });
});
