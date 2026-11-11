// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterStructureSchema, defaultSelectors } from '@assistant/contracts';
import { inspectStructure } from '../src/content/whatsapp/structure.js';

afterEach(() => vi.restoreAllMocks());

describe('privacy-preserving structural diagnostics', () => {
  it('describes wrapper metadata without extracting existing message text or identifiers', () => {
    document.body.innerHTML =
      '<div id="main"><header>Private customer</header><div data-testid="conversation-panel-messages"><div role="row" class="message-in customer-private-name" data-id="false_private-phone@lid_secret-message-id" data-pre-plain-text="private date and customer name"><span class="selectable-text copyable-text">Private historic text</span></div></div><footer><div role="textbox" contenteditable="true">Private manual draft</div></footer></div>';
    const text = document.querySelector('.selectable-text');
    if (!text) throw new Error('Missing fixture node');
    const read = vi.fn(() => 'private message');
    Object.defineProperty(text, 'textContent', { get: read });
    const report = inspectStructure(document, {
      profileId: 'fixture',
      enabled: true,
      autoSendEnabled: true,
      backgroundReplies: true,
      salt: 'fixture-salt-1234567890',
      selectors: defaultSelectors,
      duplicateWindowSeconds: 120,
      buildVersion: '0.2.3',
    });
    expect(report.textNodesInList).toBe(1);
    expect(report.incomingNodesInList).toBe(1);
    expect(
      report.samples.flat().some((node) => node.idFormat === 'incoming-prefix'),
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();
    const json = JSON.stringify(report);
    for (const secret of [
      'Private',
      'private-phone',
      'secret-message-id',
      'private date',
      'customer-private-name',
      'fixture-salt-1234567890',
    ])
      expect(json).not.toContain(secret);
  });
  it('reports trusted config flags separately from current document visibility', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const report = inspectStructure(document, {
      profileId: 'private-business-id',
      enabled: true,
      autoSendEnabled: true,
      backgroundReplies: true,
      salt: 'private-config-salt',
      selectors: defaultSelectors,
      duplicateWindowSeconds: 120,
    });
    expect(report).toMatchObject({
      enabled: true,
      autoSendEnabled: true,
      backgroundReplies: true,
      visibilityState: 'hidden',
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-business|private-config/,
    );
    const {
      autoSendEnabled,
      backgroundReplies,
      visibilityState,
      ...olderReport
    } = report;
    expect(autoSendEnabled).toBe(true);
    expect(backgroundReplies).toBe(true);
    expect(visibilityState).toBe('hidden');
    expect(AdapterStructureSchema.safeParse(olderReport).success).toBe(true);
    for (const change of [
      { autoSendEnabled: 'true' },
      { backgroundReplies: 'true' },
      { visibilityState: 'private page title' },
      { apiKey: 'private-key' },
    ])
      expect(
        AdapterStructureSchema.safeParse({ ...report, ...change }).success,
      ).toBe(false);
  });
  it('distinguishes a matched message-list container that excludes actual message text', () => {
    document.body.innerHTML =
      '<div id="main"><div data-testid="conversation-panel-messages"></div><section><div data-new-message-id="secret-value" class="x1abcd"><span class="selectable-text copyable-text">Private text</span></div></section><footer><div role="textbox" contenteditable="true"></div></footer></div>';
    const report = inspectStructure(document, {
      profileId: 'fixture',
      enabled: true,
      salt: 'fixture-salt-1234567890',
      selectors: defaultSelectors,
      duplicateWindowSeconds: 120,
    });
    expect(report.textNodesInList).toBe(0);
    expect(report).toMatchObject({
      autoSendEnabled: false,
      backgroundReplies: false,
    });
    expect(report.textNodesInMain).toBe(1);
    expect(
      report.samples
        .flat()
        .some((node) => node.attributes.includes('data-new-message-id')),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain('secret-value');
  });
});
