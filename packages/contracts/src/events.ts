import { z } from 'zod';
import {
  AssistantDecisionSchema,
  ChatScopeSchema,
  FollowupSchema,
  IdSchema,
  IncomingMessageSchema,
  TicketSchema,
  TimestampSchema,
} from './entities.js';

const DraftRequestSchema = ChatScopeSchema.extend({
  draftId: IdSchema,
  text: z.string().min(1).max(16000),
});
const SyncRequestSchema = z.strictObject({
  profileId: IdSchema,
  requestId: IdSchema,
});
const SyncResultSchema = SyncRequestSchema.extend({
  completedAt: TimestampSchema,
  status: z.enum(['SUCCESS', 'PARTIAL', 'FAILED']),
  validRowCount: z.number().int().nonnegative(),
  errors: z
    .array(
      z.strictObject({
        row: z.number().int().positive(),
        message: z.string().max(1000),
      }),
    )
    .max(1000),
});
const envelope = <T extends string, S extends z.ZodType>(type: T, payload: S) =>
  z.strictObject({ version: z.literal(1), type: z.literal(type), payload });

export const ExtensionEventSchema = z.discriminatedUnion('type', [
  envelope(
    'WHATSAPP_ADAPTER_READY',
    z.strictObject({
      ready: z.boolean(),
      selectorPackVersion: z.number().int().positive(),
    }),
  ),
  envelope(
    'WHATSAPP_ADAPTER_ERROR',
    z.strictObject({
      code: z.string().min(1).max(100),
      recoverable: z.boolean(),
    }),
  ),
  envelope('ACTIVE_CHAT_CHANGED', ChatScopeSchema),
  envelope('INCOMING_MESSAGE_DETECTED', IncomingMessageSchema),
  envelope(
    'ASSISTANT_DECISION_READY',
    ChatScopeSchema.extend({
      eventKey: IdSchema,
      decision: AssistantDecisionSchema,
    }),
  ),
  envelope('INSERT_REPLY_REQUESTED', DraftRequestSchema),
  envelope(
    'SEND_REPLY_REQUESTED',
    DraftRequestSchema.extend({
      approval: z.literal('EXPLICIT_USER_CLICK'),
    }),
  ),
  envelope(
    'HUMAN_TAKEOVER_CHANGED',
    ChatScopeSchema.extend({ active: z.boolean() }),
  ),
  envelope('KNOWLEDGE_SYNC_REQUESTED', SyncRequestSchema),
  envelope('KNOWLEDGE_SYNC_COMPLETED', SyncResultSchema),
  envelope('TICKET_CREATED', TicketSchema),
  envelope('FOLLOWUP_SCHEDULED', FollowupSchema),
  envelope('FOLLOWUP_DUE', FollowupSchema),
  envelope(
    'FOLLOWUP_COMPLETED',
    ChatScopeSchema.extend({
      followupId: IdSchema,
      completedAt: TimestampSchema,
      outcome: z.enum(['DRAFT_READY', 'SENT_OFFICIAL', 'CANCELLED', 'FAILED']),
    }),
  ),
]);

export type ExtensionEvent = z.infer<typeof ExtensionEventSchema>;
