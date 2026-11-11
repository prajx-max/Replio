import { z } from 'zod';
import {
  AssistantDecisionSchema,
  IdSchema,
  IncomingMessageSchema,
  TicketDraftSchema,
  TicketSchema,
} from './entities.js';

// Requests reference server-owned profiles; callers cannot override server policies.
export const AssistRequestSchema = z.strictObject({
  requestId: IdSchema,
  message: IncomingMessageSchema,
});
export const AssistResponseSchema = z.strictObject({
  requestId: IdSchema,
  decision: AssistantDecisionSchema,
});
export const CreateTicketRequestSchema = z.strictObject({
  idempotencyKey: IdSchema,
  draft: TicketDraftSchema,
});
export const CreateTicketResponseSchema = z.strictObject({
  ticket: TicketSchema,
});
export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  version: z.string().min(1),
});
export type AssistRequest = z.infer<typeof AssistRequestSchema>;
export type AssistResponse = z.infer<typeof AssistResponseSchema>;
