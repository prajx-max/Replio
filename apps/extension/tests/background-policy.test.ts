import { describe, expect, it, vi } from 'vitest';
import { createHarness, trustedSender } from './helpers.js';
import { ProfileEditSchema } from '../src/messaging/contracts.js';
import { BackendClient } from '../src/background/backend-client.js';
import { mockProfile } from '../src/background/mock-profile.js';

describe('background profile edit boundary', () => {
  it('preserves omitted choices, isolates profiles, and clears dependent choices when revoked', async () => {
    const { repository, route } = createHarness();
    await repository.update((settings) => ({
      ...settings,
      profiles: [
        {
          ...mockProfile,
          replyMode: 'AUTO_REPLY_WEB',
          webAutoSendOptIn: true,
          backgroundReplies: true,
          keepAwake: true,
        },
        { ...mockProfile, id: 'other-business' },
      ],
    }));
    const edit = {
      profileId: mockProfile.id,
      expectedRevision: 1,
      name: mockProfile.name,
      tone: mockProfile.tone,
      defaultLanguage: mockProfile.defaultLanguage,
      timezone: mockProfile.timezone,
      workingHours: mockProfile.workingHours.description,
      replyMode: 'AUTO_REPLY_WEB',
      webAutoSendOptIn: true,
    };
    const parsed = ProfileEditSchema.parse(edit);
    expect(parsed).not.toHaveProperty('backgroundReplies');
    expect(parsed).not.toHaveProperty('keepAwake');
    expect(
      await route({ type: 'SAVE_PROFILE', version: 1, edit }, trustedSender),
    ).toMatchObject({ ok: true });
    expect((await repository.load()).profiles[0]).toMatchObject({
      backgroundReplies: true,
      keepAwake: true,
    });
    expect((await repository.load()).profiles[1]).toMatchObject({
      backgroundReplies: false,
      keepAwake: false,
    });
    expect(
      await route(
        {
          type: 'SAVE_PROFILE',
          version: 1,
          edit: { ...edit, expectedRevision: 2, backgroundReplies: false },
        },
        trustedSender,
      ),
    ).toMatchObject({ ok: true });
    expect((await repository.load()).profiles[0]).toMatchObject({
      backgroundReplies: false,
      keepAwake: false,
    });
  });
  it('does not sync browser background and power choices to the generation backend', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    await new BackendClient(request).sync('fixture-token', {
      ...mockProfile,
      replyMode: 'AUTO_REPLY_WEB',
      webAutoSendOptIn: true,
      backgroundReplies: true,
      keepAwake: true,
    });
    const payload = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as {
      profile: Record<string, unknown>;
    };
    expect(payload.profile.replyMode).toBe('DRAFT_ONLY');
    expect(payload.profile).not.toHaveProperty('backgroundReplies');
    expect(payload.profile).not.toHaveProperty('keepAwake');
  });
});
