// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Options } from '../src/options/Options.js';
import { createHarness } from './helpers.js';

afterEach(cleanup);

const confirmation =
  'Our team will handle saved follow-ups and contact customers as promised';
const suggested = 'Our team will reach out to you soon.';

describe('saved follow-up reply settings', () => {
  it('defaults to the standard reply and fills the example without confirming the commitment', async () => {
    const harness = createHarness();
    render(<Options client={harness.client} />);
    const reply = await screen.findByRole('textbox', {
      name: 'Saved follow-up reply',
    });
    const consent = screen.getByRole('checkbox', {
      name: new RegExp('^' + confirmation),
    });
    expect(reply).toHaveProperty('value', '');
    expect(consent).toHaveProperty('checked', false);
    await userEvent.click(
      screen.getByRole('button', { name: 'Use suggested reply' }),
    );
    expect(reply).toHaveProperty('value', suggested);
    expect(consent).toHaveProperty('checked', false);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await harness.repository.load()).profiles[0]).toMatchObject({
      followupReply: suggested,
      followupCommitmentConfirmed: false,
    });
  });

  it('saves a first text edit and explicit confirmation, then restores both on reload', async () => {
    const harness = createHarness();
    const view = render(<Options client={harness.client} />);
    const reply = await screen.findByRole('textbox', {
      name: 'Saved follow-up reply',
    });
    const custom = 'Our support team will contact you soon.';
    fireEvent.change(reply, { target: { value: custom } });
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: new RegExp('^' + confirmation),
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await harness.repository.load()).profiles[0]).toMatchObject({
      followupReply: custom,
      followupCommitmentConfirmed: true,
    });
    view.unmount();
    render(<Options client={harness.client} />);
    expect(
      await screen.findByRole('textbox', { name: 'Saved follow-up reply' }),
    ).toHaveProperty('value', custom);
    expect(
      screen.getByRole('checkbox', {
        name: new RegExp('^' + confirmation),
      }),
    ).toHaveProperty('checked', true);
  });

  it('retains the editable text when confirmation is withdrawn and allows a blank reply', async () => {
    const harness = createHarness();
    await harness.repository.update((settings) => ({
      ...settings,
      profiles: settings.profiles.map((profile) => ({
        ...profile,
        followupReply: suggested,
        followupCommitmentConfirmed: true,
      })),
    }));
    render(<Options client={harness.client} />);
    const consent = await screen.findByRole('checkbox', {
      name: new RegExp('^' + confirmation),
    });
    await userEvent.click(consent);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await harness.repository.load()).profiles[0]).toMatchObject({
      followupReply: suggested,
      followupCommitmentConfirmed: false,
    });
    await userEvent.clear(
      screen.getByRole('textbox', { name: 'Saved follow-up reply' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Settings saved');
    expect((await harness.repository.load()).profiles[0]?.followupReply).toBe(
      '',
    );
  });

  it('keeps a rejected performed-action claim unsaved and visible for correction', async () => {
    const harness = createHarness();
    render(<Options client={harness.client} />);
    const reply = await screen.findByRole('textbox', {
      name: 'Saved follow-up reply',
    });
    const unsafe = 'Our team has already been notified.';
    fireEvent.change(reply, { target: { value: unsafe } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Use a short follow-up message',
    );
    expect(reply).toHaveProperty('value', unsafe);
    expect((await harness.repository.load()).profiles[0]?.followupReply).toBe(
      '',
    );
  });
});
