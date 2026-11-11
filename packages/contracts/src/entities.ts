import { z } from 'zod';

export const IdSchema = z.string().trim().min(1).max(128);
export const ChatKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.iso.datetime();
export const LanguageSchema = z.enum(['en', 'kn', 'te', 'ta', 'hi']);
export const ReplyModeSchema = z.enum([
  'OFF',
  'DRAFT_ONLY',
  'AUTO_REPLY_WEB',
  'AUTO_SAFE_OFFICIAL_TRANSPORT',
]);
export const ImportanceSchema = z.enum(['NORMAL', 'FOLLOW_UP', 'HIGH']);
export const IntentSchema = z.enum([
  'GREETING',
  'PRICE',
  'AVAILABILITY',
  'PRODUCT_DETAILS',
  'REQUIREMENTS',
  'PROCESSING_TIME',
  'BUSINESS_HOURS',
  'LOCATION',
  'CONTACT',
  'POLICY',
  'PROCESS_ENQUIRY',
  'STATUS_ENQUIRY',
  'CALLBACK',
  'CUSTOM_QUOTE',
  'COMPLAINT',
  'UNKNOWN',
]);

const HttpsUrlSchema = z.url({
  protocol: /^https$/,
  error: 'External knowledge endpoints must use HTTPS',
});
const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const WorkingHoursSchema = z.strictObject({
  description: z.string().max(500),
  outsideHoursAction: z.enum(['DRAFT', 'NO_REPLY']).default('NO_REPLY'),
  schedule: z
    .array(
      z.strictObject({
        day: z.number().int().min(0).max(6),
        opens: ClockTimeSchema,
        closes: ClockTimeSchema,
      }),
    )
    .max(21),
});
export const KnowledgeSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('STATIC_JSON'), datasetId: IdSchema }),
  z.strictObject({
    type: z.literal('PUBLIC_SHEET'),
    url: HttpsUrlSchema,
    tab: z.string().min(1).max(100),
    range: z.string().min(1).max(100).optional(),
  }),
  z.strictObject({ type: z.literal('APPS_SCRIPT'), url: HttpsUrlSchema }),
]);
export const BusinessProfileSchema = z
  .strictObject({
    id: IdSchema,
    name: z.string().trim().min(1).max(200),
    industry: z.string().trim().min(1).max(100),
    timezone: z.string().refine(
      (timezone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: timezone });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Use a valid IANA timezone' },
    ),
    website: HttpsUrlSchema.optional(),
    supportPhones: z.array(z.string().max(40)).max(10),
    languages: z.array(LanguageSchema).min(1).max(5),
    defaultLanguage: LanguageSchema,
    tone: z.enum(['friendly', 'professional', 'formal', 'casual']),
    replyInstructions: z.string().max(8000).default(''),
    businessInformation: z.string().max(16000).default(''),
    followupReply: z.string().trim().max(1000).default(''),
    followupCommitmentConfirmed: z.boolean().default(false),
    replyMode: ReplyModeSchema.default('DRAFT_ONLY'),
    webAutoSendOptIn: z.boolean().default(false),
    autoOpenUnread: z.boolean().default(false),
    includeExistingUnread: z.boolean().default(false),
    backgroundReplies: z.boolean().default(false),
    keepAwake: z.boolean().default(false),
    workingHours: WorkingHoursSchema,
    knowledgeSource: KnowledgeSourceSchema,
    thresholds: z.strictObject({
      retrievalMinimumScore: z.number().min(0).max(1),
      autoDraftMinimumConfidence: z.number().min(0).max(1),
      escalationMaximumUncertainty: z.number().min(0).max(1),
    }),
    behavior: z.strictObject({
      greetingEnabled: z.boolean(),
      replyDelayMinSeconds: z.number().int().min(0).max(3600),
      replyDelayMaxSeconds: z.number().int().min(0).max(3600),
      duplicateWindowSeconds: z.number().int().min(1).max(86400),
      perChatCooldownSeconds: z.number().int().min(0).max(86400),
      processFollowupMinutes: z.number().int().min(1).max(10080),
      unknownQueryAction: z.enum(['DRAFT_FALLBACK', 'CREATE_TICKET']),
    }),
    privacy: z.strictObject({
      logRetentionDays: z.number().int().min(1).max(365).default(30),
      storeRawMessages: z.boolean().default(false),
      maskPhoneNumbers: z.literal(true).default(true),
    }),
  })
  .superRefine((profile, context) => {
    if (
      profile.backgroundReplies &&
      (profile.replyMode !== 'AUTO_REPLY_WEB' || !profile.webAutoSendOptIn)
    )
      context.addIssue({
        code: 'custom',
        path: ['backgroundReplies'],
        message: 'Background replies require Auto-reply consent',
      });
    if (profile.keepAwake && !profile.backgroundReplies)
      context.addIssue({
        code: 'custom',
        path: ['keepAwake'],
        message: 'Enable background replies before keeping the computer awake',
      });
    if (profile.includeExistingUnread && !profile.autoOpenUnread)
      context.addIssue({
        code: 'custom',
        path: ['includeExistingUnread'],
        message:
          'Enable unread chat navigation before including existing unread chats',
      });
    if (
      profile.autoOpenUnread &&
      (profile.replyMode !== 'AUTO_REPLY_WEB' || !profile.webAutoSendOptIn)
    )
      context.addIssue({
        code: 'custom',
        path: ['autoOpenUnread'],
        message: 'Opening unread chats requires Auto-reply consent',
      });
    if (profile.replyMode === 'AUTO_REPLY_WEB' && !profile.webAutoSendOptIn)
      context.addIssue({
        code: 'custom',
        path: ['webAutoSendOptIn'],
        message: 'Confirm automatic sending before enabling Auto-reply',
      });
    if (!profile.languages.includes(profile.defaultLanguage)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultLanguage'],
        message: 'Default language must be supported',
      });
    }
    if (
      profile.behavior.replyDelayMinSeconds >
      profile.behavior.replyDelayMaxSeconds
    ) {
      context.addIssue({
        code: 'custom',
        path: ['behavior', 'replyDelayMaxSeconds'],
        message: 'Maximum delay must be at least minimum delay',
      });
    }
  });

export const KnowledgeRecordSchema = z.strictObject({
  id: IdSchema,
  profileId: IdSchema,
  record_type: z.enum([
    'PRODUCT',
    'SERVICE',
    'FAQ',
    'PROCESS',
    'POLICY',
    'OFFER',
    'CONTACT',
    'LOCATION',
  ]),
  category: z.string().max(200),
  title: z.string().trim().min(1).max(500),
  aliases: z.array(z.string().max(500)).max(100),
  sample_questions: z.array(z.string().max(2000)).max(100),
  short_answer: z.string().max(4000),
  detailed_answer: z.string().max(20000),
  price: z.string().max(500).optional(),
  availability: z.string().max(500).optional(),
  requirements: z.array(z.string().max(2000)).max(100),
  processing_time: z.string().max(500).optional(),
  process_steps: z.array(z.string().max(2000)).max(100),
  keywords: z.array(z.string().max(200)).max(100),
  language: LanguageSchema,
  priority: z.enum(['NORMAL', 'IMPORTANT']),
  requires_handoff: z.boolean(),
  active: z.boolean(),
  updated_at: TimestampSchema,
});
export const KnowledgeReferenceSchema = z.strictObject({
  profileId: IdSchema,
  recordId: IdSchema,
  title: z.string().min(1).max(500),
});
export const ChatScopeSchema = z.strictObject({
  profileId: IdSchema,
  chatKey: ChatKeySchema,
});
export const IncomingMessageSchema = ChatScopeSchema.extend({
  eventKey: IdSchema,
  messageId: IdSchema.optional(),
  direction: z.literal('INCOMING'),
  text: z.string().trim().min(1).max(16000),
  receivedAt: TimestampSchema,
});
export const TicketDraftSchema = ChatScopeSchema.extend({
  intent: IntentSchema,
  priority: ImportanceSchema,
  assignedTeam: z.string().min(1).max(100),
  matchedKnowledgeId: IdSchema.optional(),
  question: z.string().max(16000).optional(),
});
export const TicketSchema = TicketDraftSchema.extend({
  id: IdSchema,
  createdAt: TimestampSchema,
  status: z.enum(['NEW', 'NOTIFIED', 'FOLLOWUP_PENDING', 'RESOLVED', 'FAILED']),
  notifiedAt: TimestampSchema.optional(),
}).superRefine((ticket, context) => {
  if (
    (ticket.status === 'NOTIFIED' || ticket.status === 'FOLLOWUP_PENDING') &&
    !ticket.notifiedAt
  ) {
    context.addIssue({
      code: 'custom',
      path: ['notifiedAt'],
      message: 'Successful notification timestamp required',
    });
  }
});
export const FollowupSchema = ChatScopeSchema.extend({
  id: IdSchema,
  ticketId: IdSchema,
  dueAt: TimestampSchema,
  notifiedAt: TimestampSchema,
  transport: z.enum(['WHATSAPP_WEB', 'OFFICIAL']),
  status: z.enum([
    'SCHEDULED',
    'DRAFT_READY',
    'COMPLETED',
    'CANCELLED',
    'FAILED',
  ]),
});
export const AssistantDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ANSWER'),
    confidence: z.number().min(0).max(1),
    importance: ImportanceSchema,
    reply: z.string().min(1).max(16000),
    citations: z.array(KnowledgeReferenceSchema).min(1).max(20),
    sendPolicy: z.literal('DRAFT'),
  }),
  z.strictObject({
    kind: z.literal('PROCESS_ESCALATION'),
    confidence: z.number().min(0).max(1),
    importance: z.enum(['FOLLOW_UP', 'HIGH']),
    acknowledgement: z.string().min(1).max(4000),
    ticketDraft: TicketDraftSchema,
  }),
  z.strictObject({
    kind: z.literal('HUMAN_HANDOFF'),
    importance: z.literal('HIGH'),
    fallbackReply: z.string().min(1).max(4000),
    reason: z.string().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal('NO_REPLY'),
    reason: z.string().min(1).max(1000),
  }),
]);

export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
export type KnowledgeRecord = z.infer<typeof KnowledgeRecordSchema>;
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;
export type AssistantDecision = z.infer<typeof AssistantDecisionSchema>;
export type TicketDraft = z.infer<typeof TicketDraftSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type Followup = z.infer<typeof FollowupSchema>;
export type ReplyMode = z.infer<typeof ReplyModeSchema>;
export type Importance = z.infer<typeof ImportanceSchema>;
