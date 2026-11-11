// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { composerText } from '../src/content/whatsapp/composer.js';

describe('composer display text identity', () => {
  it('preserves paragraphs, line breaks, emoji and nonbreaking-space equivalents', () => {
    const editor = document.createElement('div');
    editor.innerHTML =
      '<p><span>Hello!&nbsp;Welcome 👋</span></p><p><br></p><p>Price ₹650<br>Today <img alt="🙂"></p>';
    expect(composerText(editor)).toBe(
      'Hello! Welcome 👋\n\nPrice ₹650\nToday 🙂',
    );
  });
  it('keeps meaningful internal whitespace, punctuation, URLs and IDs distinct', () => {
    const editor = document.createElement('div');
    editor.textContent = 'ID: A  B, ₹650. https://example.com/a-b';
    expect(composerText(editor)).toBe(
      'ID: A  B, ₹650. https://example.com/a-b',
    );
  });
  it('recognizes an empty editor placeholder and rejects unsupported images/deep trees', () => {
    const editor = document.createElement('div');
    editor.innerHTML = '<p><br></p>';
    expect(composerText(editor)).toBe('');
    editor.innerHTML = '<img>';
    expect(composerText(editor)).toBeNull();
    editor.innerHTML = '<span>'.repeat(45) + 'Deep' + '</span>'.repeat(45);
    expect(composerText(editor)).toBeNull();
  });
});
