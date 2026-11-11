// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AdapterDiagnostics } from '../src/options/AdapterDiagnostics.js';
import { inspectStructure } from '../src/content/whatsapp/structure.js';
import { createHarness } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function diagnosticState(
  savedBackground: boolean,
  adapterBackground: boolean,
) {
  const { client } = createHarness();
  const state = await client.request({ version: 1, type: 'GET_STATE' });
  const first = state.settings.profiles[0];
  if (!first) throw new Error('Missing fixture profile');
  const profile = {
    ...first,
    id: 'private-active-profile',
    name: 'Private business',
    replyMode: 'AUTO_REPLY_WEB' as const,
    webAutoSendOptIn: true,
    autoOpenUnread: true,
    includeExistingUnread: true,
    backgroundReplies: savedBackground,
    keepAwake: savedBackground,
    replyInstructions: 'Private instructions and secret-api-key',
    businessInformation: 'Private business facts',
  };
  state.settings.activeProfileId = profile.id;
  state.settings.profiles.push(profile);
  state.settings.revision = 42;
  state.settings.connections[profile.id] = {
    token: 'private-pairing-capability',
    autoSuggest: true,
  };
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  state.live = {
    tabId: 123,
    status: {
      ready: true,
      context: {
        profileId: profile.id,
        chatKey: 'a'.repeat(64),
        contextId: 'private-context',
        chatLabel: 'Private customer 9998887770',
      },
      matches: {
        appShell: 0,
        chatHeader: 0,
        messageList: 0,
        incomingMessage: 0,
        outgoingMessage: -1,
        messageText: 0,
        composer: 0,
        sendButton: -1,
      },
      structure: inspectStructure(document, {
        profileId: profile.id,
        enabled: true,
        autoSendEnabled: true,
        backgroundReplies: adapterBackground,
        buildVersion: '0.7.0',
        salt: 'private-config-salt',
        selectors: state.settings.selectors,
        duplicateWindowSeconds: 120,
      }),
      unread: 'WATCHING',
      unreadPending: 0,
      unreadDiagnostics: {
        visible: false,
        lastVisibleListFound: true,
        lastVisibleRows: 19,
        lastVisibleUnreadRows: 0,
        initialScanPending: false,
        existingUnreadQueued: 0,
      },
    },
    message: {
      eventKey: 'private-event-id',
      text: 'Private customer question',
    },
    suggestion: null,
  };
  return state;
}

describe('background diagnostic report', () => {
  it('reports the active saved policy and adapter flags without customer data or credentials', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '0.7.0' }) },
    });
    const state = await diagnosticState(true, true);
    render(<AdapterDiagnostics state={state} busy={false} act={vi.fn()} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>(
      'Structural diagnostic report',
    );
    expect(JSON.parse(textarea.value)).toMatchObject({
      installedVersion: '0.7.0',
      savedPolicy: {
        revision: 42,
        enabled: true,
        replyMode: 'AUTO_REPLY_WEB',
        webAutoSendOptIn: true,
        autoOpenUnread: true,
        includeExistingUnread: true,
        backgroundReplies: true,
        keepAwake: true,
      },
      structure: {
        enabled: true,
        autoSendEnabled: true,
        backgroundReplies: true,
        visibilityState: 'hidden',
      },
    });
    expect(textarea.value).not.toMatch(/private|secret-api-key|9998887770/i);
    expect(
      screen.getByText(/adapter has background replies enabled/),
    ).toBeTruthy();
    expect(screen.queryByText(/Return to its tab to continue/)).toBeNull();
  });
  it.each([false, undefined])(
    'explains saved background consent not confirmed by adapter flag %s',
    async (flag) => {
      const state = await diagnosticState(true, false);
      if (flag === undefined && state.live?.status.structure)
        delete state.live.status.structure.backgroundReplies;
      render(<AdapterDiagnostics state={state} busy={false} act={vi.fn()} />);
      expect(screen.getByText(/adapter has not confirmed them/)).toBeTruthy();
      expect(screen.queryByText(/Return to its tab to continue/)).toBeNull();
    },
  );
  it('copies the current reply and backend stages without copying the message or draft', async () => {
    const state = await diagnosticState(true, true);
    if (!state.live) throw new Error('Missing fixture chat');
    state.backend = {
      paired: true,
      configured: true,
      provider: 'gemini',
      model: 'private-model-name',
      error: '',
    };
    state.live.suggestion = {
      id: 'private-suggestion-id',
      state: 'READY',
      reply: 'Private generated reply',
      needsHuman: false,
      provider: 'gemini',
      model: 'private-model-name',
      error: '',
      delivery: { state: 'BLOCKED', reason: 'COMPOSER_BUSY' },
    };
    render(<AdapterDiagnostics state={state} busy={false} act={vi.fn()} />);
    const report = screen.getByLabelText<HTMLTextAreaElement>(
      'Structural diagnostic report',
    ).value;
    expect(JSON.parse(report)).toMatchObject({
      backend: { paired: true, configured: true, error: null },
      currentReply: {
        messagePresent: true,
        paused: false,
        suggestion: 'READY',
        generationError: null,
        delivery: 'BLOCKED',
        deliveryReason: 'COMPOSER_BUSY',
      },
    });
    expect(report).not.toMatch(/private|secret-api-key/i);
  });
  it('reports a known generation failure and redacts unknown error strings', async () => {
    const state = await diagnosticState(true, true);
    if (!state.live) throw new Error('Missing fixture chat');
    state.backend.error = 'Private transport detail';
    state.live.suggestion = {
      id: 'private-suggestion-id',
      state: 'ERROR',
      reply: '',
      needsHuman: true,
      provider: '',
      model: '',
      error: 'KEY_REJECTED',
    };
    render(<AdapterDiagnostics state={state} busy={false} act={vi.fn()} />);
    const report = screen.getByLabelText<HTMLTextAreaElement>(
      'Structural diagnostic report',
    ).value;
    expect(JSON.parse(report)).toMatchObject({
      backend: { error: 'UNKNOWN' },
      currentReply: {
        suggestion: 'ERROR',
        generationError: 'KEY_REJECTED',
        delivery: null,
      },
    });
    expect(report).not.toMatch(/private transport detail/i);
  });
  it('keeps foreground guidance when no background consent is saved or reported', async () => {
    const state = await diagnosticState(false, false);
    render(<AdapterDiagnostics state={state} busy={false} act={vi.fn()} />);
    expect(screen.getByText(/Return to its tab to continue/)).toBeTruthy();
  });
});
