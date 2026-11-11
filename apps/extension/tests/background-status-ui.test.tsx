// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LiveWorkspace } from '../src/sidepanel/LiveWorkspace.js';
import { AdapterDiagnostics } from '../src/options/AdapterDiagnostics.js';
import { BackgroundRuntimeStatusSchema } from '../src/messaging/contracts.js';
import { createHarness } from './helpers.js';

afterEach(cleanup);

async function state() {
  const h = createHarness();
  await h.repository.update((settings) => ({
    ...settings,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      replyMode: 'AUTO_REPLY_WEB',
      webAutoSendOptIn: true,
      backgroundReplies: true,
    })),
  }));
  return h.client.request({ type: 'GET_STATE', version: 1 });
}

describe('background eligibility status', () => {
  it.each([
    ['MULTIPLE_WHATSAPP_TABS', /Keep only one WhatsApp Web tab open/],
    ['TAB_FROZEN', /Chrome froze WhatsApp/],
    ['TAB_DISCARDED', /Chrome unloaded WhatsApp/],
    ['BACKEND_DISCONNECTED', /Connect this business to its AI backend/],
  ] as const)(
    'explains %s without promising that replies are running',
    async (reason, text) => {
      const settings = await state();
      settings.backgroundRuntime = { state: reason, tabCount: 2 };
      render(<LiveWorkspace state={settings} busy={false} act={vi.fn()} />);
      expect(screen.getByText(text)).toBeTruthy();
    },
  );
  it('does not treat an unavailable diagnostic as ready', async () => {
    render(<LiveWorkspace state={await state()} busy={false} act={vi.fn()} />);
    expect(
      screen.getByText(/Background eligibility could not be checked/),
    ).toBeTruthy();
  });
  it('clears the blocker after browser eligibility becomes ready', async () => {
    const settings = await state();
    settings.backgroundRuntime = {
      state: 'MULTIPLE_WHATSAPP_TABS',
      tabCount: 2,
    };
    const view = render(
      <LiveWorkspace state={settings} busy={false} act={vi.fn()} />,
    );
    expect(
      screen.getByText(/Keep only one WhatsApp Web tab open/),
    ).toBeTruthy();
    view.rerender(
      <LiveWorkspace
        state={{
          ...settings,
          backgroundRuntime: { state: 'READY', tabCount: 1 },
        }}
        busy={false}
        act={vi.fn()}
      />,
    );
    expect(
      screen.queryByText(/Keep only one WhatsApp Web tab open/),
    ).toBeNull();
    expect(
      screen.queryByText(/Background eligibility could not be checked/),
    ).toBeNull();
  });
  it('includes the worker blocker in the copied structural report', async () => {
    const settings = await state();
    settings.backgroundRuntime = {
      state: 'MULTIPLE_WHATSAPP_TABS',
      tabCount: 2,
    };
    render(<AdapterDiagnostics state={settings} busy={false} act={vi.fn()} />);
    const text = screen.getByLabelText<HTMLTextAreaElement>(
      'Structural diagnostic report',
    ).value;
    expect(JSON.parse(text)).toMatchObject({
      backgroundRuntime: { state: 'MULTIPLE_WHATSAPP_TABS', tabCount: 2 },
    });
    expect(
      BackgroundRuntimeStatusSchema.safeParse({
        ...settings.backgroundRuntime,
        tabId: 7,
        url: 'https://private.example',
      }).success,
    ).toBe(false);
  });
  it('explains a skipped unread chat even when the queue is empty', async () => {
    const settings = await state();
    settings.backgroundRuntime = { state: 'READY', tabCount: 1 };
    settings.live = {
      tabId: 1,
      message: null,
      suggestion: null,
      status: {
        ready: true,
        context: null,
        matches: {
          appShell: 0,
          chatHeader: 0,
          messageList: 0,
          incomingMessage: 0,
          outgoingMessage: 0,
          messageText: 0,
          composer: 0,
          sendButton: -1,
        },
        unread: 'WATCHING',
        unreadPending: 0,
        unreadDiagnostics: {
          visible: true,
          lastVisibleListFound: true,
          lastVisibleRows: 17,
          lastVisibleUnreadRows: 1,
          initialScanPending: false,
          existingUnreadQueued: 0,
          lastSkipReason: 'TARGET_PAUSED',
        },
      },
    };
    render(<LiveWorkspace state={settings} busy={false} act={vi.fn()} />);
    expect(
      screen.getByText(/Auto-reply is paused for the unread chat/),
    ).toBeTruthy();
  });
});
