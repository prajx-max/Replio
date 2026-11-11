import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BusinessProfileSchema,
  HandoffRecordSchema,
} from '@assistant/contracts';
import { mockProfile } from '../src/background/mock-profile.js';
import { HANDOFF_KEY, HandoffInbox } from '../src/background/handoff-inbox.js';
import { MemoryArea } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T12:00:00.000Z'));
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const profile = (id = 'business', raw = false, retention = 30) =>
  BusinessProfileSchema.parse({
    ...mockProfile,
    id,
    privacy: {
      ...mockProfile.privacy,
      storeRawMessages: raw,
      logRetentionDays: retention,
    },
  });
const source = (event = 'a') => ({
  chatKey: 'c'.repeat(64),
  sourceEventKey: event.repeat(64),
  chatLabel: 'Fixture customer',
  reason: 'CALLBACK',
  question: 'Please call me about my application.',
});

describe('durable local admin follow-up inbox', () => {
  it('persists before returning and deduplicates the same profile/chat/source across recreation', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const saved = await inbox.create(profile(), source());
    expect(saved.created).toBe(true);
    expect(HandoffRecordSchema.safeParse(saved.record).success).toBe(true);
    const restarted = new HandoffInbox(local);
    expect(await restarted.list(profile())).toEqual([saved.record]);
    expect(await restarted.create(profile(), source())).toEqual({
      record: saved.record,
      created: false,
    });
    expect(JSON.stringify(local.values)).not.toContain(source().question);
  });
  it('serializes concurrent duplicate saves and independent status updates without losing rows', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const copies = await Promise.all(
      Array.from({ length: 5 }, () => inbox.create(profile(), source())),
    );
    expect(copies.filter((saved) => saved.created)).toHaveLength(1);
    const second = await inbox.create(profile(), source('b'));
    await Promise.all([
      inbox.setStatus(profile(), copies[0]!.record.id, 'IN_PROGRESS'),
      inbox.setStatus(profile(), second.record.id, 'RESOLVED'),
    ]);
    const rows = await new HandoffInbox(local).list(profile());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.status))).toEqual(
      new Set(['IN_PROGRESS', 'RESOLVED']),
    );
    expect((await inbox.create(profile(), source('b'))).record.status).toBe(
      'RESOLVED',
    );
  });
  it('isolates profiles even for identical source hashes and rejects a different profile status change', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const first = await inbox.create(profile('one'), source());
    const second = await inbox.create(profile('two'), source());
    expect(first.record.id).not.toBe(second.record.id);
    expect(await inbox.list(profile('one'))).toEqual([first.record]);
    expect(await inbox.list(profile('two'))).toEqual([second.record]);
    await expect(
      inbox.setStatus(profile('two'), first.record.id, 'RESOLVED'),
    ).rejects.toMatchObject({ code: 'HANDOFF_NOT_FOUND' });
    expect((await inbox.list(profile('one')))[0]?.status).toBe('OPEN');
  });
  it('stores a question only after explicit profile opt-in and durably removes it on revocation', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const privateText = 'My private application question';
    const saved = await inbox.create(profile('one', true), {
      ...source(),
      question: privateText,
    });
    const other = await inbox.create(profile('two', true), {
      ...source(),
      question: 'Other business private text',
    });
    expect(saved.record.question).toBe(privateText);
    expect(JSON.stringify(local.values)).toContain(privateText);
    expect(
      (await inbox.list(profile('one', false)))[0]?.question,
    ).toBeUndefined();
    expect(JSON.stringify(local.values)).not.toContain(privateText);
    expect(
      (await new HandoffInbox(local).list(profile('one', true)))[0]?.question,
    ).toBeUndefined();
    expect((await inbox.list(profile('two', true)))[0]).toEqual(other.record);
  });
  it('does not add raw text to an existing privacy-minimal record during a duplicate retry', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    await inbox.create(profile(), source());
    const duplicate = await inbox.create(profile('business', true), source());
    expect(duplicate.created).toBe(false);
    expect(duplicate.record.question).toBeUndefined();
    expect(JSON.stringify(local.values)).not.toContain(source().question);
  });
  it('masks phone-like labels without storing raw phone or WhatsApp identity fields', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const saved = await inbox.create(profile(), {
      ...source(),
      chatLabel: 'Customer +91 98765 43210',
    });
    expect(saved.record.chatLabel).toBe('Customer [phone hidden]');
    expect(JSON.stringify(local.values)).not.toContain('98765');
    expect(() =>
      inbox.create(profile(), { ...source('b'), phone: '+919876543210' }),
    ).toThrow();
  });
  it('expires retained records durably and applies a shorter current policy without extending earlier expiry', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const saved = await inbox.create(profile('business', false, 10), source());
    const extended = await inbox.list(profile('business', false, 30));
    expect(extended[0]?.expiresAt).toBe(saved.record.expiresAt);
    const shortened = await inbox.list(profile('business', false, 2));
    expect(shortened[0]?.expiresAt).toBe('2026-11-10T12:00:00.000Z');
    vi.advanceTimersByTime(2 * 86400000);
    expect(await inbox.list(profile('business', false, 2))).toEqual([]);
    expect(local.values[HANDOFF_KEY]).toEqual({});
    expect(await new HandoffInbox(local).list(profile())).toEqual([]);
  });
  it('reports capacity rather than dropping unresolved work and recovers capacity only after retention expiry', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local, 2);
    const first = await inbox.create(profile(), source());
    await inbox.create(profile(), source('b'));
    await expect(inbox.create(profile(), source('d'))).rejects.toMatchObject({
      code: 'HANDOFF_CAPACITY',
    });
    expect(await inbox.list(profile())).toHaveLength(2);
    expect((await inbox.create(profile(), source())).record.id).toBe(
      first.record.id,
    );
    vi.advanceTimersByTime(31 * 86400000);
    expect((await inbox.create(profile(), source('d'))).created).toBe(true);
    expect(await inbox.list(profile())).toHaveLength(1);
  });
  it('never reports saved or changed after a failed storage write and can retry after the failure', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    const write = vi
      .spyOn(local, 'set')
      .mockRejectedValueOnce(
        new Error('Quota; secret details must not escape'),
      );
    await expect(inbox.create(profile(), source())).rejects.toMatchObject({
      message: 'HANDOFF_STORAGE_FAILED',
      code: 'HANDOFF_STORAGE_FAILED',
    });
    expect(await inbox.list(profile())).toEqual([]);
    const saved = await inbox.create(profile(), source());
    write.mockRejectedValueOnce(new Error('write blocked'));
    await expect(
      inbox.setStatus(profile(), saved.record.id, 'RESOLVED'),
    ).rejects.toMatchObject({ code: 'HANDOFF_STORAGE_FAILED' });
    expect((await new HandoffInbox(local).list(profile()))[0]?.status).toBe(
      'OPEN',
    );
  });
  it('fails closed without returning raw text if revocation cannot persist its scrub', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    await inbox.create(profile('business', true), source());
    vi.spyOn(local, 'set').mockRejectedValueOnce(new Error('Quota'));
    await expect(inbox.list(profile())).rejects.toMatchObject({
      code: 'HANDOFF_STORAGE_FAILED',
    });
    expect((await inbox.list(profile()))[0]?.question).toBeUndefined();
  });
  it('rejects malformed storage and valid-looking entries moved to a different ownership hash', async () => {
    const local = new MemoryArea();
    const inbox = new HandoffInbox(local);
    await inbox.create(profile(), source());
    const entries = local.values[HANDOFF_KEY] as Record<string, unknown>;
    const record = Object.values(entries)[0];
    local.values[HANDOFF_KEY] = { ['f'.repeat(64)]: record };
    await expect(inbox.list(profile())).rejects.toMatchObject({
      code: 'HANDOFF_INVALID_STORAGE',
    });
    local.values[HANDOFF_KEY] = { malformed: { question: 'Do not echo me' } };
    await expect(inbox.list(profile())).rejects.toMatchObject({
      message: 'HANDOFF_INVALID_STORAGE',
    });
  });
});
