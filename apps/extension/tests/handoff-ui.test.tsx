// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HandoffRecordSchema } from '@assistant/contracts';
import type { HandoffRecord } from '@assistant/contracts';
import { AdminFollowups } from '../src/options/HandoffInbox.js';
import { LiveWorkspace } from '../src/sidepanel/LiveWorkspace.js';
import { Options } from '../src/options/Options.js';
import { ShellStateSchema } from '../src/messaging/contracts.js';
import type { ShellRequest, ShellState } from '../src/messaging/contracts.js';
import { defaultSettings } from '../src/background/mock-profile.js';
import { createHarness } from './helpers.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function record(change: Partial<HandoffRecord> = {}) {
  return HandoffRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    profileId: 'sweet-crumbs-demo',
    chatKey: 'a'.repeat(64),
    sourceEventKey: 'b'.repeat(64),
    chatLabel: 'Customer One',
    reason: 'CALLBACK',
    status: 'OPEN',
    createdAt: '2026-11-08T10:00:00.000Z',
    updatedAt: '2026-11-08T10:00:00.000Z',
    expiresAt: '2026-12-08T10:00:00.000Z',
    ...change,
  });
}
function state(
  handoffs: HandoffRecord[] = [],
  storeQuestions = false,
): ShellState {
  const settings = defaultSettings();
  settings.profiles[0]!.privacy.storeRawMessages = storeQuestions;
  return ShellStateSchema.parse({
    settings,
    knowledgeStatus: 'SAMPLE_DATA',
    demo: null,
    handoffs,
  });
}

describe('admin follow-up inbox', () => {
  it('filters by status and active business, and hides questions when storage is disabled', async () => {
    const open = record({ question: 'Private callback question' });
    const working = record({
      id: '22222222-2222-4222-8222-222222222222',
      chatLabel: 'Customer Two',
      status: 'IN_PROGRESS',
      reason: 'UNRESOLVED',
    });
    const resolved = record({
      id: '33333333-3333-4333-8333-333333333333',
      chatLabel: 'Customer Three',
      status: 'RESOLVED',
    });
    const foreign = record({
      id: '44444444-4444-4444-8444-444444444444',
      profileId: 'another-business',
      chatLabel: 'Other business customer',
    });
    render(
      <AdminFollowups
        state={state([open, working, resolved, foreign])}
        busy={false}
        act={vi.fn().mockResolvedValue(true)}
      />,
    );
    expect(screen.getByText('2 need attention')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Customer One' })).toBeTruthy();
    expect(screen.queryByText('Customer Two')).toBeNull();
    expect(screen.queryByText('Private callback question')).toBeNull();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Show follow-ups' }),
      'IN_PROGRESS',
    );
    expect(screen.getByRole('article', { name: 'Customer Two' })).toBeTruthy();
    expect(screen.queryByText('Customer One')).toBeNull();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Show follow-ups' }),
      'RESOLVED',
    );
    expect(
      screen.getByRole('article', { name: 'Customer Three' }),
    ).toBeTruthy();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Show follow-ups' }),
      'ALL',
    );
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText('Other business customer')).toBeNull();
  });
  it('renders opted-in questions as text and sends exact owned status updates', async () => {
    const request = record({ question: '<img src=x onerror=alert(1)>' });
    const act = vi
      .fn<(request: ShellRequest) => Promise<boolean>>()
      .mockResolvedValue(true);
    const { container } = render(
      <AdminFollowups state={state([request], true)} busy={false} act={act} />,
    );
    expect(screen.getByText(request.question!)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Mark in progress' }),
    );
    expect(act).toHaveBeenLastCalledWith({
      version: 1,
      type: 'UPDATE_HANDOFF',
      profileId: request.profileId,
      id: request.id,
      status: 'IN_PROGRESS',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(act).toHaveBeenLastCalledWith({
      version: 1,
      type: 'UPDATE_HANDOFF',
      profileId: request.profileId,
      id: request.id,
      status: 'RESOLVED',
    });
  });
  it('reopens resolved requests only through an explicit update', async () => {
    const request = record({ status: 'RESOLVED' });
    const act = vi
      .fn<(request: ShellRequest) => Promise<boolean>>()
      .mockResolvedValue(true);
    render(<AdminFollowups state={state([request])} busy={false} act={act} />);
    expect(act).not.toHaveBeenCalled();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Show follow-ups' }),
      'RESOLVED',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(act).toHaveBeenCalledWith({
      version: 1,
      type: 'UPDATE_HANDOFF',
      profileId: request.profileId,
      id: request.id,
      status: 'OPEN',
    });
  });
  it('keeps the saved status truthful after a failed update and prevents concurrent clicks', async () => {
    let finish: (saved: boolean) => void = () => {};
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const act = vi
      .fn<(request: ShellRequest) => Promise<boolean>>()
      .mockReturnValue(pending);
    render(<AdminFollowups state={state([record()])} busy={false} act={act} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(screen.getByRole('button', { name: 'Resolve' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText('Saving follow-up…')).toBeTruthy();
    finish(false);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The follow-up could not be updated. Please try again.',
    );
    expect(
      within(screen.getByRole('article', { name: 'Customer One' })).getByText(
        'Open',
      ),
    ).toBeTruthy();
    expect(act).toHaveBeenCalledTimes(1);
  });
  it('separates an unavailable inbox from an empty inbox and offers a refresh', async () => {
    const current = state();
    current.handoffError = 'HANDOFF_STORAGE_ERROR';
    const act = vi
      .fn<(request: ShellRequest) => Promise<boolean>>()
      .mockResolvedValue(true);
    const view = render(
      <AdminFollowups state={current} busy={false} act={act} />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Some follow-ups could not be loaded or saved',
    );
    expect(screen.queryByText(/No follow-ups yet/)).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh follow-ups' }),
    );
    expect(act).toHaveBeenCalledWith({ type: 'GET_STATE', version: 1 });
    view.rerender(<AdminFollowups state={state()} busy={false} act={act} />);
    expect(screen.getByText(/No follow-ups yet/)).toBeTruthy();
  });
  it.each(['HANDOFF_CAPACITY', 'HANDOFF_STORAGE_FAILED'])(
    'keeps existing requests visible and actionable after %s',
    async (error) => {
      const request = record();
      const current = state([request]);
      current.handoffError = error;
      const act = vi
        .fn<(request: ShellRequest) => Promise<boolean>>()
        .mockResolvedValue(true);
      render(<AdminFollowups state={current} busy={false} act={act} />);
      expect(
        screen.getByRole('article', { name: request.chatLabel }),
      ).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain(
        error === 'HANDOFF_CAPACITY'
          ? 'inbox is full. New requests could not be saved'
          : 'could not be loaded or saved',
      );
      expect(screen.queryByText(/No follow-ups yet/)).toBeNull();
      await userEvent.click(
        screen.getByRole('button', { name: 'Mark in progress' }),
      );
      expect(act).toHaveBeenCalledWith({
        version: 1,
        type: 'UPDATE_HANDOFF',
        profileId: request.profileId,
        id: request.id,
        status: 'IN_PROGRESS',
      });
    },
  );
});

describe('follow-up privacy settings', () => {
  it('defaults full questions off and persists explicit question and retention choices', async () => {
    const harness = createHarness();
    render(<Options client={harness.client} />);
    const checkbox = await screen.findByRole('checkbox', {
      name: /^Save customer questions in follow-ups on this PC/,
    });
    expect(checkbox).toHaveProperty('checked', false);
    await userEvent.click(checkbox);
    const retention = screen.getByRole('spinbutton', {
      name: /^Follow-up retention/,
    });
    await userEvent.clear(retention);
    await userEvent.type(retention, '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect(
      (await harness.repository.load()).profiles[0]!.privacy,
    ).toMatchObject({ storeRawMessages: true, logRetentionDays: 14 });
  });
  it('uses the saved revision for a second privacy edit', async () => {
    const harness = createHarness();
    render(<Options client={harness.client} />);
    const checkbox = await screen.findByRole('checkbox', {
      name: /^Save customer questions in follow-ups on this PC/,
    });
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    const saved = await harness.repository.load();
    expect(saved.revision).toBe(2);
    expect(saved.profiles[0]!.privacy.storeRawMessages).toBe(false);
  });
  it('preserves the first unsaved instruction when another window updates settings', async () => {
    const harness = createHarness();
    let notify = () => {};
    const client = {
      ...harness.client,
      subscribe(onChange: () => void) {
        notify = onChange;
        return () => {};
      },
    };
    render(<Options client={client} />);
    await screen.findByLabelText('Business name');
    const instructions = screen.getByRole('textbox', {
      name: /^Reply instructions/,
    });
    fireEvent.change(instructions, {
      target: { value: 'My unsaved first edit.' },
    });
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        replyInstructions: 'Changed in another window.',
      })),
    }));
    await act(async () => {
      notify();
    });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('Settings changed elsewhere'),
    );
    expect(instructions).toHaveProperty('value', 'My unsaved first edit.');
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('live follow-up acknowledgement', () => {
  it.each(['SAVED', 'SAVE_FAILED'] as const)(
    'labels %s without promising a callback',
    (result) => {
      const current = state();
      current.live = {
        tabId: 1,
        status: {
          ready: true,
          context: {
            profileId: current.settings.activeProfileId,
            contextId: 'test-chat',
            chatKey: 'a'.repeat(64),
            chatLabel: 'Customer One',
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
        },
        message: { eventKey: 'b'.repeat(64), text: 'Please call me' },
        suggestion: {
          id: 'saved-acknowledgement',
          state: 'READY',
          reply: 'A truthful acknowledgement.',
          needsHuman: true,
          provider: 'assistant',
          model: 'admin-follow-up',
          error: '',
          handoff:
            result === 'SAVED'
              ? {
                  state: 'SAVED',
                  reason: 'CALLBACK',
                  id: '11111111-1111-4111-8111-111111111111',
                }
              : { state: 'SAVE_FAILED', reason: 'CALLBACK' },
        },
      };
      render(
        <LiveWorkspace
          state={current}
          busy={false}
          act={vi.fn().mockResolvedValue(true)}
        />,
      );
      expect(
        screen.getByRole('heading', {
          name:
            result === 'SAVED'
              ? 'Admin follow-up saved'
              : 'Follow-up needs manual attention',
        }),
      ).toBeTruthy();
      expect(
        screen.queryByText(
          'Confirmed information was missing or the output needed a safer fallback.',
        ),
      ).toBeNull();
      expect(
        screen.getByText(
          result === 'SAVED'
            ? /No separate team notification was sent and no callback is guaranteed/
            : /Saving this request could not be confirmed/,
        ),
      ).toBeTruthy();
    },
  );
});
