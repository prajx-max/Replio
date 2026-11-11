import { z } from 'zod';
import { BusinessProfileSchema, ChatKeySchema, IdSchema } from './entities.js';

export const ProviderSchema = z.enum([
  'openai',
  'gemini',
  'anthropic',
  'groq',
  'deepseek',
  'openrouter',
  'mistral',
  'xai',
  'together',
  'custom',
]);
export const ResponseFormatSchema = z.enum(['json_object', 'text']);
// Syntax is only the first boundary. The backend also validates and pins DNS
// addresses before connecting, so a public-looking name cannot target a LAN.
const baseUrlPattern =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::443)?((?:\/[a-z0-9._~/-]*)?)$/i;
export const CustomProviderBaseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    const parts = value.match(baseUrlPattern);
    const host = parts?.[1];
    const path = parts?.[2] ?? '';
    return Boolean(
      host &&
      host.length <= 253 &&
      !/(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/i.test(
        host,
      ) &&
      !/(?:^|\/)\.{1,2}(?:\/|$)/.test(path) &&
      !/\/chat\/completions\/*$/i.test(path),
    );
  }, 'Use a public HTTPS API base URL, without credentials, query parameters or /chat/completions')
  .transform((value) => {
    const parts = value.match(baseUrlPattern);
    return `https://${parts?.[1]?.toLowerCase() ?? ''}${(parts?.[2] ?? '').replace(/\/+$/, '')}`;
  });
export const ModelIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/);
export const ProviderOptionsSchema = z
  .strictObject({
    provider: ProviderSchema,
    model: ModelIdSchema,
    baseUrl: CustomProviderBaseUrlSchema.optional(),
    responseFormat: ResponseFormatSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.provider === 'custom') !== (value.baseUrl !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Only a custom provider requires an API base URL',
      });
    if (
      ['openai', 'gemini', 'anthropic'].includes(value.provider) &&
      value.responseFormat !== undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['responseFormat'],
        message: 'Native providers select their own response format',
      });
  });
export const ProviderConfigurationSchema = ProviderOptionsSchema.safeExtend({
  profileId: IdSchema,
  apiKey: z
    .string()
    .trim()
    .max(512)
    .regex(/^[a-zA-Z0-9_.:+/=-]{8,512}$/)
    .optional(),
  remember: z.boolean().optional(),
});
export const ProviderStatusSchema = z.strictObject({
  configured: z.boolean(),
  provider: ProviderSchema.nullable(),
  model: z.string().max(128),
});
export const ModelReplySchema = z.strictObject({
  reply: z.string().trim().min(1).max(4000),
  needsHuman: z.boolean(),
  evidenceIds: z.array(z.enum(['business-information'])).max(1),
});
export const SuggestionRequestSchema = z.strictObject({
  profileId: IdSchema,
  chatKey: ChatKeySchema,
  requestId: IdSchema,
  text: z.string().trim().min(1).max(16000),
});
export const SuggestionResponseSchema = z.strictObject({
  requestId: IdSchema,
  reply: z.string().min(1).max(4000),
  needsHuman: z.boolean(),
  provider: ProviderSchema,
  model: ModelIdSchema,
  grounded: z.boolean(),
});
export const ProfileSyncSchema = z.strictObject({
  profile: BusinessProfileSchema,
});
export const ServiceErrorSchema = z.enum([
  'NOT_CONFIGURED',
  'UNAUTHORIZED',
  'INVALID_REQUEST',
  'KEY_REJECTED',
  'MODEL_REJECTED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INVALID_OUTPUT',
  'PROFILE_MISSING',
  'CONFIGURATION_SAVE_FAILED',
  'ENDPOINT_REJECTED',
]);
export type Provider = z.infer<typeof ProviderSchema>;
export type ProviderConfiguration = z.infer<typeof ProviderConfigurationSchema>;
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
export type ModelReply = z.infer<typeof ModelReplySchema>;
export type SuggestionRequest = z.infer<typeof SuggestionRequestSchema>;
export type ServiceError = z.infer<typeof ServiceErrorSchema>;
