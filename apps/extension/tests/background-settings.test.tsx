// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { webcrypto } from 'node:crypto';
import { Options } from '../src/options/Options.js';
import { createHarness } from './helpers.js';

const request = vi.fn<() => Promise<boolean>>();
const contains = vi.fn<() => Promise<boolean>>();
beforeEach(() => {
  request.mockReset().mockResolvedValue(true);
  contains.mockReset().mockResolvedValue(true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(),
      openOptionsPage: vi.fn(),
    },
    permissions: { request, contains },
    tabs: { create: vi.fn() },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function automaticSettings(backgroundReplies = false, keepAwake = false) {
  const harness = createHarness();
  await harness.repository.update((settings) => ({
    ...settings,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      replyMode: 'AUTO_REPLY_WEB',
      webAutoSendOptIn: true,
      backgroundReplies,
      keepAwake,
    })),
  }));
  return harness;
}
const background = () =>
  screen.getByRole('checkbox', {
    name: /^Reply while WhatsApp is in the background/,
  });
const awake = () =>
  screen.getByRole('checkbox', {
    name: /^Keep computer awake while Replio runs/,
  });

describe('background reply preferences', () => {
  it('requires an explicit click for power permission and saves/restores both preferences', async () => {
    const { repository, client } = await automaticSettings();
    const view = render(<Options client={client} />);
    await screen.findByRole('checkbox', {
      name: /^Reply while WhatsApp is in the background/,
    });
    expect(background()).toHaveProperty('checked', false);
    expect(request).not.toHaveBeenCalled();
    await userEvent.click(background());
    expect(awake()).toHaveProperty('checked', false);
    await userEvent.click(awake());
    await waitFor(() => expect(awake()).toHaveProperty('checked', true));
    expect(request).toHaveBeenCalledExactlyOnceWith({ permissions: ['power'] });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await repository.load()).profiles[0]).toMatchObject({
      backgroundReplies: true,
      keepAwake: true,
    });
    view.unmount();
    render(<Options client={client} />);
    await screen.findByRole('checkbox', {
      name: /^Keep computer awake while Replio runs/,
    });
    expect(background()).toHaveProperty('checked', true);
    expect(awake()).toHaveProperty('checked', true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('leaves keep-awake off after permission denial without disabling background replies', async () => {
    request.mockResolvedValue(false);
    const { client, repository } = await automaticSettings(true);
    render(<Options client={client} />);
    await screen.findByRole('checkbox', {
      name: /^Keep computer awake while Replio runs/,
    });
    await userEvent.click(awake());
    await screen.findByText(/Chrome did not allow keep-awake/);
    expect(awake()).toHaveProperty('checked', false);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await repository.load()).profiles[0]).toMatchObject({
      backgroundReplies: true,
      keepAwake: false,
    });
  });
  it('does not apply a late permission response after background replies were disabled', async () => {
    let finish: (allowed: boolean) => void = () => undefined;
    request.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { client, repository } = await automaticSettings(true);
    render(<Options client={client} />);
    await screen.findByRole('checkbox', {
      name: /^Keep computer awake while Replio runs/,
    });
    await userEvent.click(awake());
    await screen.findByText('Waiting for Chrome permission…');
    await userEvent.click(background());
    await act(async () => {
      finish(true);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await repository.load()).profiles[0]).toMatchObject({
      backgroundReplies: false,
      keepAwake: false,
    });
  });
  it.each(['Draft only', 'Off'])(
    'clears background and keep-awake when changing mode to %s',
    async (name) => {
      const { client, repository } = await automaticSettings(true, true);
      render(<Options client={client} />);
      await userEvent.click(
        await screen.findByRole('radio', { name: new RegExp(`^${name}`) }),
      );
      await userEvent.click(
        screen.getByRole('button', { name: 'Save changes' }),
      );
      await screen.findByText('Settings saved');
      expect((await repository.load()).profiles[0]).toMatchObject({
        backgroundReplies: false,
        keepAwake: false,
      });
    },
  );
  it('explains revoked Chrome permission without automatically requesting it', async () => {
    contains.mockResolvedValue(false);
    const { client } = await automaticSettings(true, true);
    render(<Options client={client} />);
    await screen.findByText(/Chrome permission is missing/);
    expect(request).not.toHaveBeenCalled();
  });
});
