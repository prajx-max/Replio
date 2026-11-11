import { z } from 'zod';
import { isSafeFollowupReply } from '@assistant/core';
import {
  BusinessProfileSchema,
  ExtensionEventSchema,
  IdSchema,
  LiveStateSchema,
  SelectorPackSchema,
  defaultSelectors,
  ProviderStatusSchema,
  AdapterContextSchema,
  ChatKeySchema,
  HandoffRecordSchema,
  HandoffStatusSchema,
} from '@assistant/contracts';

export const SettingsSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    activeProfileId: IdSchema,
    profiles: z.array(BusinessProfileSchema).min(1).max(20),
    connections: z
      .record(
        IdSchema,
        z.strictObject({
          token: z.string().max(512),
          autoSuggest: z.boolean(),
        }),
      )
      .default({}),
    selectors: SelectorPackSchema.default(defaultSelectors),
    takeovers: z
      .record(
        ChatKeySchema,
        z.strictObject({
          profileId: IdSchema,
          chatKey: ChatKeySchema,
          pausedAt: z.number().nonnegative(),
          titleKey: ChatKeySchema.optional(),
        }),
      )
      .default({}),
  })
  .superRefine((settings, context) => {
    if (
      Object.entries(settings.takeovers).some(
        ([key, value]) =>
          key !== value.chatKey ||
          !settings.profiles.some((profile) => profile.id === value.profileId),
      ) ||
      Object.keys(settings.takeovers).length > 256
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid chat pause ownership or capacity',
      });
    if (
      !settings.profiles.some(
        (profile) => profile.id === settings.activeProfileId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Active profile is missing',
      });
    }
    if (
      new Set(settings.profiles.map((profile) => profile.id)).size !==
      settings.profiles.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Profile IDs must be unique',
      });
    }
    if (
      settings.profiles.some(
        (profile) => profile.replyMode === 'AUTO_SAFE_OFFICIAL_TRANSPORT',
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'The official transport mode is unavailable in the web extension',
      });
    }
  });
export const DemoRunSchema = z
  .strictObject({
    profileId: IdSchema,
    customerMessage: z.literal(
      'What is the price of your Chocolate Truffle Cake?',
    ),
    language: z.literal('en'),
    intent: z.literal('PRICE'),
    event: ExtensionEventSchema.refine(
      (event) => event.type === 'ASSISTANT_DECISION_READY',
      {
        message: 'Expected an assistant decision event',
      },
    ),
  })
  .superRefine((demo, context) => {
    if (demo.event.type !== 'ASSISTANT_DECISION_READY') return;
    const payload = demo.event.payload;
    if (
      payload.profileId !== demo.profileId ||
      payload.decision.kind !== 'ANSWER' ||
      payload.decision.citations.some(
        (citation) => citation.profileId !== demo.profileId,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Sample decision must belong to the sample profile',
      });
    }
  });
export const BackgroundRuntimeStatusSchema = z.strictObject({
  state: z.enum([
    'READY',
    'ASSISTANT_DISABLED',
    'AUTO_REPLY_DISABLED',
    'BACKGROUND_DISABLED',
    'BACKEND_DISCONNECTED',
    'NO_WHATSAPP_TAB',
    'MULTIPLE_WHATSAPP_TABS',
    'TAB_DISCARDED',
    'TAB_FROZEN',
    'TAB_NAVIGATING',
    'SETTINGS_CHANGED',
    'CHECK_FAILED',
  ]),
  tabCount: z.number().int().min(0).max(10000).nullable(),
});
export type BackgroundRuntimeStatus = z.infer<
  typeof BackgroundRuntimeStatusSchema
>;
export const ShellStateSchema = z.strictObject({
  settings: SettingsSchema,
  adapterStatus: z
    .enum(['NOT_IMPLEMENTED', 'WAITING', 'READY'])
    .default('WAITING'),
  knowledgeStatus: z.literal('SAMPLE_DATA'),
  demo: DemoRunSchema.nullable(),
  live: LiveStateSchema.nullable().default(null),
  backgroundRuntime: BackgroundRuntimeStatusSchema.optional(),
  handoffs: z.array(HandoffRecordSchema).max(512).default([]),
  handoffError: z.string().max(100).default(''),
  backend: ProviderStatusSchema.extend({
    paired: z.boolean(),
    error: z.string().max(100),
  }).default({
    configured: false,
    provider: null,
    model: '',
    paired: false,
    error: '',
  }),
});
export const ProfileEditSchema = z
  .strictObject({
    profileId: IdSchema,
    expectedRevision: z.number().int().nonnegative(),
    name: BusinessProfileSchema.shape.name,
    tone: BusinessProfileSchema.shape.tone,
    defaultLanguage: BusinessProfileSchema.shape.defaultLanguage,
    timezone: BusinessProfileSchema.shape.timezone,
    workingHours: z.string().trim().min(1).max(500),
    replyMode: z.enum(['OFF', 'DRAFT_ONLY', 'AUTO_REPLY_WEB']),
    webAutoSendOptIn: z.boolean().default(false),
    autoOpenUnread: z.boolean().optional(),
    includeExistingUnread: z.boolean().optional(),
    backgroundReplies: z.boolean().optional(),
    keepAwake: z.boolean().optional(),
    perChatCooldownSeconds:
      BusinessProfileSchema.shape.behavior.shape.perChatCooldownSeconds.optional(),
    replyInstructions: BusinessProfileSchema.shape.replyInstructions,
    businessInformation: BusinessProfileSchema.shape.businessInformation,
    followupReply: BusinessProfileSchema.shape.followupReply
      .removeDefault()
      .optional(),
    followupCommitmentConfirmed:
      BusinessProfileSchema.shape.followupCommitmentConfirmed
        .removeDefault()
        .optional(),
    storeRawMessages: BusinessProfileSchema.shape.privacy.shape.storeRawMessages
      .removeDefault()
      .optional(),
    logRetentionDays: BusinessProfileSchema.shape.privacy.shape.logRetentionDays
      .removeDefault()
      .optional(),
  })
  .superRefine((edit, context) => {
    if (
      (edit.backgroundReplies || edit.keepAwake) &&
      (edit.replyMode !== 'AUTO_REPLY_WEB' || !edit.webAutoSendOptIn)
    )
      context.addIssue({
        code: 'custom',
        message: 'Enable Auto-reply before enabling background replies',
      });
    if (edit.keepAwake && edit.backgroundReplies === false)
      context.addIssue({
        code: 'custom',
        message: 'Enable background replies before keeping the computer awake',
      });
    if (edit.followupReply && !isSafeFollowupReply(edit.followupReply))
      context.addIssue({
        code: 'custom',
        path: ['followupReply'],
        message:
          'Use a short follow-up message without links, numbers or claims that a team was already notified.',
      });
    if (edit.includeExistingUnread && !edit.autoOpenUnread)
      context.addIssue({
        code: 'custom',
        message:
          'Enable unread chat navigation before including existing unread chats',
      });
    if (
      edit.autoOpenUnread &&
      (edit.replyMode !== 'AUTO_REPLY_WEB' || !edit.webAutoSendOptIn)
    )
      context.addIssue({
        code: 'custom',
        message: 'Enable Auto-reply before opening unread chats',
      });
    if (edit.replyMode === 'AUTO_REPLY_WEB' && !edit.webAutoSendOptIn)
      context.addIssue({
        code: 'custom',
        message: 'Confirm automatic sending before enabling Auto-reply',
      });
  });
export const ShellRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    version: z.literal(1),
    type: z.literal('UPDATE_HANDOFF'),
    profileId: IdSchema,
    id: z.uuid(),
    status: HandoffStatusSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('SET_CHAT_TAKEOVER'),
    context: AdapterContextSchema,
    paused: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('RECONNECT_WHATSAPP'),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('CONNECT_BACKEND'),
    token: z.string().trim().max(512),
    autoSuggest: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('DISCONNECT_BACKEND'),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('RETRY_SUGGESTION'),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('INSERT_LIVE_DRAFT'),
    suggestionId: IdSchema,
    text: z.string().trim().min(1).max(4000),
    approval: z.literal('EXPLICIT_USER_CLICK'),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('SAVE_SELECTORS'),
    selectors: SelectorPackSchema,
  }),
  z.strictObject({ version: z.literal(1), type: z.literal('GET_STATE') }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('SET_ENABLED'),
    enabled: z.boolean(),
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('SET_ACTIVE_PROFILE'),
    profileId: IdSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('SAVE_PROFILE'),
    edit: ProfileEditSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal('RUN_MOCK'),
    profileId: IdSchema,
  }),
]);
export const ErrorCodeSchema = z.enum([
  'WHATSAPP_UNAVAILABLE',
  'UNAUTHORIZED',
  'INVALID_REQUEST',
  'STORAGE_ERROR',
  'PROFILE_CHANGED',
  'DISABLED',
  'CONFLICT',
  'UNAVAILABLE',
  'BACKEND_ERROR',
  'STALE_DRAFT',
  'COMPOSER_BUSY',
]);
export const ShellResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), state: ShellStateSchema }),
  z.strictObject({ ok: z.literal(false), error: ErrorCodeSchema }),
]);
export type Settings = z.infer<typeof SettingsSchema>;
export type ShellState = z.infer<typeof ShellStateSchema>;
export type ShellRequest = z.infer<typeof ShellRequestSchema>;
export type ShellResponse = z.infer<typeof ShellResponseSchema>;
export type ProfileEdit = z.infer<typeof ProfileEditSchema>;
export type DemoRun = z.infer<typeof DemoRunSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
