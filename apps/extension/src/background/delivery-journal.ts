import { z } from 'zod';
import { ChatKeySchema, IdSchema } from '@assistant/contracts';
import type { BusinessProfile } from '@assistant/contracts';
import type { StorageArea } from '../storage/settings-repository.js';

export const DELIVERY_KEY = 'assistant.webDelivery.v1';
const entrySchema = z.strictObject({
  profileId: IdSchema,
  chatKey: ChatKeySchema,
  eventKey: ChatKeySchema,
  createdAt: z.number().nonnegative(),
  expiresAt: z.number().nonnegative(),
  state: z.enum(['ATTEMPTING', 'SENT', 'BLOCKED', 'UNCERTAIN']),
});
const journalSchema = z.record(ChatKeySchema, entrySchema);
type Entry = z.infer<typeof entrySchema>;
export async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
const scopeKey = (entry: Pick<Entry, 'profileId' | 'chatKey' | 'eventKey'>) =>
  digest(`${entry.profileId}:${entry.chatKey}:${entry.eventKey}`);

/** Only hashes/timestamps persist. Any reserved attempt survives worker restart;
 * an uncertain attempt is never automatically retried. */
export class DeliveryJournal {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly local: StorageArea) {}
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async load() {
    const raw = (await this.local.get(DELIVERY_KEY))[DELIVERY_KEY];
    const entries = journalSchema.parse(raw ?? {});
    if (Object.keys(entries).length > 512) throw new Error('Delivery capacity');
    for (const [key, entry] of Object.entries(entries)) {
      if (key !== (await scopeKey(entry)) || entry.expiresAt <= entry.createdAt)
        throw new Error('Invalid delivery ownership');
    }
    return Object.fromEntries(
      Object.entries(entries).filter(
        ([, entry]) => entry.expiresAt > Date.now(),
      ),
    );
  }
  claim(profile: BusinessProfile, chatKey: string, eventKey: string) {
    return this.serialize(async () => {
      const entries = await this.load();
      const key = await scopeKey({ profileId: profile.id, chatKey, eventKey });
      if (entries[key])
        return { ok: false, reason: 'ALREADY_ATTEMPTED' } as const;
      if (
        Object.values(entries).some(
          (entry) =>
            entry.profileId === profile.id &&
            entry.chatKey === chatKey &&
            Date.now() - entry.createdAt <
              profile.behavior.perChatCooldownSeconds * 1000,
        )
      )
        return { ok: false, reason: 'COOLDOWN' } as const;
      if (Object.keys(entries).length >= 512)
        return { ok: false, reason: 'DELIVERY_CAPACITY' } as const;
      const now = Date.now();
      const entry = entrySchema.parse({
        profileId: profile.id,
        chatKey,
        eventKey,
        createdAt: now,
        expiresAt: now + profile.privacy.logRetentionDays * 86400000,
        state: 'ATTEMPTING',
      });
      // Persist before any command capable of clicking Send is issued.
      await this.local.set({ [DELIVERY_KEY]: { ...entries, [key]: entry } });
      return { ok: true, key } as const;
    });
  }
  cooldownUntil(profile: BusinessProfile, chatKey: string) {
    return this.serialize(async () => {
      const entries = await this.load();
      return Math.max(
        0,
        ...Object.values(entries)
          .filter(
            (entry) =>
              entry.profileId === profile.id && entry.chatKey === chatKey,
          )
          .map(
            (entry) =>
              entry.createdAt + profile.behavior.perChatCooldownSeconds * 1000,
          ),
      );
    });
  }
  finish(key: string, state: Exclude<Entry['state'], 'ATTEMPTING'>) {
    return this.serialize(async () => {
      const entries = await this.load();
      const entry = entries[key];
      if (!entry || entry.state !== 'ATTEMPTING')
        throw new Error('Missing delivery claim');
      await this.local.set({
        [DELIVERY_KEY]: { ...entries, [key]: { ...entry, state } },
      });
    });
  }
}
