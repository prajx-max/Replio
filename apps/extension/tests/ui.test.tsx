// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Popup } from '../src/popup/Popup.js';
import { SidePanel } from '../src/sidepanel/SidePanel.js';
import { Options } from '../src/options/Options.js';
import { assistantClient } from '../src/messaging/client.js';
import { createHarness } from './helpers.js';
import { EnabledSwitch } from '../src/ui/shared.js';
import { LiveWorkspace } from '../src/sidepanel/LiveWorkspace.js';

const sendMessage = vi.fn<(request: unknown) => Promise<unknown>>();

beforeEach(() => {
  sendMessage.mockReset();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      openOptionsPage: vi.fn().mockResolvedValue(undefined),
      sendMessage,
    },
    windows: { getCurrent: vi.fn().mockResolvedValue({ id: 42 }) },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    tabs: { create: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('popup controls', () => {
  it('reflects a pending toggle immediately and rolls back a failed save', async () => {
    let finish: (success: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    render(<EnabledSwitch enabled disabled={false} onChange={() => pending} />);
    const toggle = screen.getByRole('checkbox', {
      name: 'Assistant enabled',
    }) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
    await act(async () => {
      finish(false);
      await pending;
    });
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });
  it('persists the enabled switch and opens the side panel in the user click', async () => {
    const { client, repository } = createHarness();
    render(<Popup client={client} />);
    const toggle = await screen.findByRole('checkbox', {
      name: 'Assistant enabled',
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);
    await waitFor(() =>
      expect((toggle as HTMLInputElement).checked).toBe(false),
    );
    expect((await repository.load()).enabled).toBe(false);
    await userEvent.click(
      screen.getByRole('button', { name: /Open reply workspace/ }),
    );
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 });
    expect(screen.getByText('Adapter pending')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
  });
});

describe('reply workspace', () => {
  it.each([
    [
      'UNAUTHORIZED',
      'The backend no longer accepts this extension’s pairing code.',
    ],
    ['KEY_REJECTED', 'Your AI provider rejected its API key.'],
  ])(
    'explains %s and opens setup scoped to the active business',
    async (error, explanation) => {
      const { client } = createHarness();
      const state = await client.request({ type: 'GET_STATE', version: 1 });
      const profileId = 'business & branch';
      state.settings.activeProfileId = profileId;
      state.settings.profiles = state.settings.profiles.map((profile) => ({
        ...profile,
        id: profileId,
      }));
      state.live = {
        tabId: 1,
        status: {
          ready: true,
          context: {
            profileId,
            chatKey: 'a'.repeat(64),
            contextId: 'current-chat',
            chatLabel: 'Test customer',
          },
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
        },
        message: { eventKey: 'new-message', text: 'Hello' },
        suggestion: {
          id: 'failed-suggestion',
          state: 'ERROR',
          reply: '',
          needsHuman: true,
          provider: '',
          model: '',
          error,
        },
      };
      const act = vi.fn().mockResolvedValue(true);
      render(<LiveWorkspace state={state} busy={false} act={act} />);
      expect(screen.getByRole('alert').textContent).toContain(explanation);
      if (error === 'KEY_REJECTED')
        expect(screen.getByRole('alert').textContent).not.toContain(
          'connect again',
        );
      await userEvent.click(
        screen.getByRole('button', {
          name: /Open AI setup for this business/,
        }),
      );
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'http://127.0.0.1:3000/setup?profileId=business%20%26%20branch',
      });
      expect(act).not.toHaveBeenCalled();
    },
  );
  it('renders a typed sample event, preserves exact facts, and keeps sending unavailable', async () => {
    const { client } = createHarness();
    render(<SidePanel client={client} />);
    await userEvent.click(
      await screen.findByText('Optional sample preview', { exact: true }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Try a sample enquiry/ }),
    );
    const editor = await screen.findByRole('textbox', {
      name: 'Suggested reply',
    });
    expect((editor as HTMLTextAreaElement).value).toContain(
      '₹650 for 500 grams',
    );
    expect(
      (screen.getByRole('button', { name: 'Send reply' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Insert draft',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(editor, { target: { value: 'A draft I edited myself.' } });
    expect((editor as HTMLTextAreaElement).value).toBe(
      'A draft I edited myself.',
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Run sample again/ }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole('textbox', {
            name: 'Suggested reply',
          }) as HTMLTextAreaElement
        ).value,
      ).toContain('₹650 for 500 grams'),
    );
    expect(
      screen.getByText(
        'Fictional conversation. This sample does not read or send WhatsApp messages.',
      ),
    ).toBeTruthy();
  });
  it('blocks the sample when disabled', async () => {
    const { client, repository } = createHarness();
    await repository.update((settings) => ({ ...settings, enabled: false }));
    render(<SidePanel client={client} />);
    await userEvent.click(
      await screen.findByText('Optional sample preview', { exact: true }),
    );
    const button = await screen.findByRole('button', {
      name: /Try a sample enquiry/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('profile settings', () => {
  it('saves the reply interval and preserves zero cooldown across unrelated profile edits', async () => {
    const { client, repository } = createHarness();
    const view = render(<Options client={client} />);
    const interval = await screen.findByRole('spinbutton', {
      name: /^Minimum time between replies \(seconds\)/,
    });
    expect(interval).toHaveProperty('value', '10');
    fireEvent.change(interval, { target: { value: '0' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect(
      (await repository.load()).profiles[0]?.behavior.perChatCooldownSeconds,
    ).toBe(0);
    view.unmount();
    render(<Options client={client} />);
    expect(
      await screen.findByRole('spinbutton', {
        name: /^Minimum time between replies \(seconds\)/,
      }),
    ).toHaveProperty('value', '0');
    fireEvent.change(screen.getByLabelText('Business name'), {
      target: { value: 'Updated business' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect(
      (await repository.load()).profiles[0]?.behavior.perChatCooldownSeconds,
    ).toBe(0);
  });
  it('shows Auto-reply as enabled while keeping the fictional sample unavailable', async () => {
    const { client, repository } = createHarness();
    await repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        replyMode: 'AUTO_REPLY_WEB',
        webAutoSendOptIn: true,
      })),
    }));
    render(<SidePanel client={client} />);
    expect(await screen.findByText('Enabled', { exact: true })).toBeTruthy();
    expect(screen.queryByText('Paused', { exact: true })).toBeNull();
    await userEvent.click(
      screen.getByText('Optional sample preview', { exact: true }),
    );
    expect(
      screen.getByRole('button', { name: /Try a sample enquiry/ }),
    ).toHaveProperty('disabled', true);
  });
  it('requires separate auto-send consent, saves the mode and preserves it on reload', async () => {
    const { client, repository } = createHarness();
    const view = render(<Options client={client} />);
    await userEvent.click(
      await screen.findByRole('radio', { name: /^Auto-reply/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Confirm automatic sending',
    );
    expect((await repository.load()).profiles[0]?.replyMode).toBe('DRAFT_ONLY');
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: /^Allow automatic sending without review/,
      }),
    );
    const openUnread = screen.getByRole('checkbox', {
      name: /^Open new unread chats automatically/,
    });
    expect(openUnread).toHaveProperty('checked', false);
    await userEvent.click(openUnread);
    const existing = screen.getByRole('checkbox', {
      name: /^Include chats that are already unread/,
    });
    expect(existing).toHaveProperty('checked', false);
    await userEvent.click(existing);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await repository.load()).profiles[0]?.replyMode).toBe(
      'AUTO_REPLY_WEB',
    );
    expect((await repository.load()).profiles[0]?.webAutoSendOptIn).toBe(true);
    expect((await repository.load()).profiles[0]?.autoOpenUnread).toBe(true);
    expect((await repository.load()).profiles[0]?.includeExistingUnread).toBe(
      true,
    );
    view.unmount();
    render(<Options client={client} />);
    expect(
      await screen.findByRole('radio', { name: /^Auto-reply/ }),
    ).toHaveProperty('checked', true);
    await userEvent.click(screen.getByRole('radio', { name: /^Draft only/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await repository.load()).profiles[0]?.webAutoSendOptIn).toBe(false);
    expect((await repository.load()).profiles[0]?.autoOpenUnread).toBe(false);
    expect((await repository.load()).profiles[0]?.includeExistingUnread).toBe(
      false,
    );
  });
  it('saves edits through the router and restores them on a fresh page', async () => {
    const { client, repository } = createHarness();
    const view = render(<Options client={client} />);
    const input = await screen.findByLabelText('Business name');
    fireEvent.change(
      screen.getByRole('textbox', { name: /^Reply instructions/ }),
      { target: { value: 'Be brief and courteous.' } },
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /^Business information/ }),
      { target: { value: 'Verified business facts.' } },
    );
    fireEvent.change(input, { target: { value: 'My Sample Bakery' } });
    await userEvent.selectOptions(
      screen.getByLabelText('Tone'),
      'professional',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await repository.load()).profiles[0]?.name).toBe(
      'My Sample Bakery',
    );
    expect((await repository.load()).profiles[0]?.tone).toBe('professional');
    expect((await repository.load()).profiles[0]?.replyInstructions).toBe(
      'Be brief and courteous.',
    );
    expect((await repository.load()).profiles[0]?.businessInformation).toBe(
      'Verified business facts.',
    );
    view.unmount();
    render(<Options client={client} />);
    expect(
      ((await screen.findByLabelText('Business name')) as HTMLInputElement)
        .value,
    ).toBe('My Sample Bakery');
  });
  it('shows timezone validation and preserves unsaved input', async () => {
    const { client, repository } = createHarness();
    render(<Options client={client} />);
    const input = await screen.findByLabelText('Timezone');
    fireEvent.change(input, { target: { value: 'invalid/timezone' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Use a valid IANA timezone',
    );
    expect((input as HTMLInputElement).value).toBe('invalid/timezone');
    expect((await repository.load()).revision).toBe(0);
  });
  it('renders untrusted profile text as text rather than HTML', async () => {
    const { repository, client } = createHarness();
    const name = '<img src=x onerror=alert(1)>';
    await repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({ ...profile, name })),
    }));
    const { container } = render(<Options client={client} />);
    await screen.findByText(name);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('message client validation', () => {
  it('rejects malformed worker responses', async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      state: {},
    });
    await expect(
      assistantClient.request({ version: 1, type: 'GET_STATE' }),
    ).rejects.toThrow('invalid response');
  });
  it('shows a recoverable error for worker failure', async () => {
    sendMessage.mockRejectedValue(new Error('internal failure'));
    await expect(
      assistantClient.request({ version: 1, type: 'GET_STATE' }),
    ).rejects.toThrow('service worker is unavailable');
  });
});
