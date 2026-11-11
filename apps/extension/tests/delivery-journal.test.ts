import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeliveryJournal,
  DELIVERY_KEY,
  digest,
} from '../src/background/delivery-journal.js';
import { mockProfile } from '../src/background/mock-profile.js';
import { MemoryArea } from './helpers.js';

const chatKey = 'a'.repeat(64);
const eventKey = 'b'.repeat(64);
afterEach(() => vi.restoreAllMocks());
describe('durable automatic delivery reservation', () => {
  it('persists before delivery, deduplicates concurrent claims and survives restart without raw text', async () => {
    const local = new MemoryArea();
    const journal = new DeliveryJournal(local);
    const [first, second] = await Promise.all([
      journal.claim(mockProfile, chatKey, eventKey),
      journal.claim(mockProfile, chatKey, eventKey),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'ALREADY_ATTEMPTED' });
    const restarted = new DeliveryJournal(local);
    expect(await restarted.claim(mockProfile, chatKey, eventKey)).toEqual(
      second,
    );
    const saved = JSON.stringify(local.values);
    expect(saved).toContain('ATTEMPTING');
    expect(saved).not.toContain('reply');
    expect(saved).not.toContain('text');
    if (!first.ok) throw new Error('Missing claim');
    await restarted.finish(first.key, 'UNCERTAIN');
    expect(
      await new DeliveryJournal(local).claim(mockProfile, chatKey, eventKey),
    ).toEqual(second);
  });
  it('isolates businesses and chats while enforcing persisted per-chat cooldown', async () => {
    const journal = new DeliveryJournal(new MemoryArea());
    expect((await journal.claim(mockProfile, chatKey, eventKey)).ok).toBe(true);
    expect(await journal.claim(mockProfile, chatKey, 'c'.repeat(64))).toEqual({
      ok: false,
      reason: 'COOLDOWN',
    });
    expect(
      (await journal.claim(mockProfile, 'd'.repeat(64), eventKey)).ok,
    ).toBe(true);
    expect(
      (
        await journal.claim(
          { ...mockProfile, id: 'other-business' },
          chatKey,
          eventKey,
        )
      ).ok,
    ).toBe(true);
  });
  it('rejects corrupted scope metadata instead of resetting the journal', async () => {
    const local = new MemoryArea();
    local.values[DELIVERY_KEY] = {
      ['f'.repeat(64)]: {
        profileId: mockProfile.id,
        chatKey,
        eventKey,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000,
        state: 'SENT',
      },
    };
    await expect(
      new DeliveryJournal(local).claim(mockProfile, chatKey, eventKey),
    ).rejects.toThrow('ownership');
  });
  it('cannot return a send reservation when persistence fails', async () => {
    const local = new MemoryArea();
    vi.spyOn(local, 'set').mockRejectedValue(new Error('disk unavailable'));
    await expect(
      new DeliveryJournal(local).claim(mockProfile, chatKey, eventKey),
    ).rejects.toThrow();
  });
  it('expires metadata using configured retention', async () => {
    const local = new MemoryArea();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1000000);
    const journal = new DeliveryJournal(local);
    const short = {
      ...mockProfile,
      privacy: { ...mockProfile.privacy, logRetentionDays: 1 },
    };
    expect((await journal.claim(short, chatKey, eventKey)).ok).toBe(true);
    clock.mockReturnValue(1000000 + 86400001);
    expect((await journal.claim(short, chatKey, eventKey)).ok).toBe(true);
  });
  it('fails closed at capacity without evicting an unexpired attempted send', async () => {
    const local = new MemoryArea();
    const entries = await Promise.all(
      Array.from({ length: 512 }, async (_, index) => {
        const entry = {
          profileId: mockProfile.id,
          chatKey: await digest(String(index)),
          eventKey,
          createdAt: Date.now() - 20000,
          expiresAt: Date.now() + 86400000,
          state: 'ATTEMPTING',
        };
        return [
          await digest(`${entry.profileId}:${entry.chatKey}:${entry.eventKey}`),
          entry,
        ];
      }),
    );
    local.values[DELIVERY_KEY] = Object.fromEntries(entries);
    expect(
      await new DeliveryJournal(local).claim(mockProfile, chatKey, eventKey),
    ).toEqual({ ok: false, reason: 'DELIVERY_CAPACITY' });
    expect(Object.keys(local.values[DELIVERY_KEY] as object)).toHaveLength(512);
  });
});
