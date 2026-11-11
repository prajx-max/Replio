import { z } from 'zod';
import { ChatKeySchema, IdSchema, TimestampSchema } from './entities.js';

export const HandoffReasonSchema = z.enum(['CALLBACK', 'UNRESOLVED']);
export const HandoffStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']);
export const HandoffInputSchema = z.strictObject({
  chatKey: ChatKeySchema,
  sourceEventKey: ChatKeySchema,
  chatLabel: z.string().trim().min(1).max(120),
  reason: HandoffReasonSchema,
  question: z.string().trim().min(1).max(16000).optional(),
});
export const HandoffRecordSchema = HandoffInputSchema.extend({
  id: z.uuid(),
  profileId: IdSchema,
  status: HandoffStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).superRefine((record, context) => {
  if (
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    Date.parse(record.expiresAt) <= Date.parse(record.updatedAt)
  )
    context.addIssue({
      code: 'custom',
      message: 'Invalid handoff timestamps',
    });
});

export type HandoffInput = z.infer<typeof HandoffInputSchema>;
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
