import { z } from 'zod';
import {
  BusinessProfileSchema,
  ChatKeySchema,
  HandoffInputSchema,
  HandoffRecordSchema,
  HandoffStatusSchema,
} from '@assistant/contracts';
import type { BusinessProfile, HandoffStatus } from '@assistant/contracts';
import type { StorageArea } from '../storage/settings-repository.js';
import { digest } from './delivery-journal.js';

export const HANDOFF_KEY = 'assistant.handoffs.v1';
const storeSchema = z.record(ChatKeySchema, HandoffRecordSchema);
type FailureCode =
  | 'HANDOFF_CAPACITY'
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_STORAGE_FAILED'
  | 'HANDOFF_INVALID_STORAGE';
export class HandoffFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = 'HandoffFailure';
  }
}
const recordKey = (record: {
  profileId: string;
  chatKey: string;
  sourceEventKey: string;
}) => digest(`${record.profileId}:${record.chatKey}:${record.sourceEventKey}`);
// Adapter labels are already masked; defend against unmasked legacy or imported
// labels without ever persisting a separate phone or raw WhatsApp identifier.
const maskedLabel = (label: string) =>
  label.replace(/\+?\d[\d\s()-]{5,}\d/g, '[phone hidden]').slice(0, 120);

/** Durable local admin work only. No notification, callback or message delivery
 * is implied by a successful write. Raw questions require the profile opt-in. */
export class HandoffInbox {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly capacity: number;
  constructor(
    private readonly local: StorageArea,
    capacity = 512,
  ) {
    this.capacity = z.number().int().min(1).max(512).parse(capacity);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof HandoffFailure) throw error;
        throw new HandoffFailure('HANDOFF_STORAGE_FAILED');
      }
    });
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async read(profile: BusinessProfile) {
    const raw = (await this.local.get(HANDOFF_KEY))[HANDOFF_KEY];
    const parsed = storeSchema.safeParse(raw ?? {});
    if (!parsed.success || Object.keys(parsed.data).length > 512)
      throw new HandoffFailure('HANDOFF_INVALID_STORAGE');
    const entries = parsed.data;
    let changed = false;
    const now = Date.now();
    const ids = new Set<string>();
    for (const [key, record] of Object.entries(entries)) {
      if (key !== (await recordKey(record)) || ids.has(record.id))
        throw new HandoffFailure('HANDOFF_INVALID_STORAGE');
      ids.add(record.id);
      if (record.profileId === profile.id) {
        const expiresAt = Math.min(
          Date.parse(record.expiresAt),
          Date.parse(record.createdAt) +
            profile.privacy.logRetentionDays * 86400000,
        );
        if (Date.parse(record.expiresAt) !== expiresAt) {
          record.expiresAt = new Date(expiresAt).toISOString();
          changed = true;
        }
        if (
          !profile.privacy.storeRawMessages &&
          record.question !== undefined
        ) {
          delete record.question;
          changed = true;
        }
        const label = maskedLabel(record.chatLabel);
        if (label !== record.chatLabel) {
          record.chatLabel = label;
          changed = true;
        }
      }
      if (Date.parse(record.expiresAt) <= now) {
        delete entries[key];
        changed = true;
      }
    }
    if (changed) await this.local.set({ [HANDOFF_KEY]: entries });
    return entries;
  }
  create(profileInput: BusinessProfile, input: unknown) {
    const profile = BusinessProfileSchema.parse(profileInput);
    const source = HandoffInputSchema.parse(input);
    return this.serialize(async () => {
      const entries = await this.read(profile);
      const key = await recordKey({ ...source, profileId: profile.id });
      const existing = entries[key];
      if (existing) return { record: existing, created: false };
      if (Object.keys(entries).length >= this.capacity)
        throw new HandoffFailure('HANDOFF_CAPACITY');
      const now = new Date().toISOString();
      const record = HandoffRecordSchema.parse({
        id: crypto.randomUUID(),
        profileId: profile.id,
        chatKey: source.chatKey,
        sourceEventKey: source.sourceEventKey,
        chatLabel: maskedLabel(source.chatLabel),
        reason: source.reason,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(
          Date.parse(now) + profile.privacy.logRetentionDays * 86400000,
        ).toISOString(),
        ...(profile.privacy.storeRawMessages && source.question !== undefined
          ? { question: source.question }
          : {}),
      });
      await this.local.set({ [HANDOFF_KEY]: { ...entries, [key]: record } });
      return { record, created: true };
    });
  }
  list(profileInput: BusinessProfile) {
    const profile = BusinessProfileSchema.parse(profileInput);
    return this.serialize(async () =>
      Object.values(await this.read(profile))
        .filter((record) => record.profileId === profile.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
  }
  setStatus(
    profileInput: BusinessProfile,
    idInput: string,
    statusInput: HandoffStatus,
  ) {
    const profile = BusinessProfileSchema.parse(profileInput);
    const id = z.uuid().parse(idInput);
    const status = HandoffStatusSchema.parse(statusInput);
    return this.serialize(async () => {
      const entries = await this.read(profile);
      const entry = Object.entries(entries).find(
        ([, record]) => record.id === id && record.profileId === profile.id,
      );
      if (!entry) throw new HandoffFailure('HANDOFF_NOT_FOUND');
      const [key, current] = entry;
      if (current.status === status) return current;
      const record = HandoffRecordSchema.parse({
        ...current,
        status,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(current.updatedAt)),
        ).toISOString(),
      });
      await this.local.set({ [HANDOFF_KEY]: { ...entries, [key]: record } });
      return record;
    });
  }
}
