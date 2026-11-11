import {
  ProviderStatusSchema,
  SuggestionResponseSchema,
  ServiceErrorSchema,
} from '@assistant/contracts';
import type { BusinessProfile, SuggestionRequest } from '@assistant/contracts';

export const BACKEND_ORIGIN =
  import.meta.env.MODE === 'fixture'
    ? 'http://127.0.0.1:4175'
    : 'http://127.0.0.1:3000';
export class BackendFailure extends Error {}
export class BackendClient {
  constructor(
    private readonly request: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
    private readonly origin = BACKEND_ORIGIN,
  ) {}
  private async call(
    path: string,
    token: string,
    input?: unknown,
    timeoutMs = 23000,
  ) {
    try {
      const response = await this.request(`${this.origin}${path}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          'x-assistant-token': token,
          ...(input === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const code = ServiceErrorSchema.safeParse(
          typeof result === 'object' && result !== null && 'error' in result
            ? result.error
            : null,
        );
        throw new BackendFailure(
          code.success ? code.data : 'PROVIDER_UNAVAILABLE',
        );
      }
      return result;
    } catch (error) {
      if (error instanceof BackendFailure) throw error;
      throw new BackendFailure('BACKEND_OFFLINE');
    }
  }
  async status(token: string, timeoutMs = 23000) {
    return ProviderStatusSchema.parse(
      await this.call('/api/status', token, undefined, timeoutMs),
    );
  }
  async sync(token: string, profile: BusinessProfile) {
    // Generation remains draft-only. Delivery policy and consent belong to the
    // extension; omit them for compatibility with an already-running backend.
    const {
      webAutoSendOptIn,
      autoOpenUnread,
      includeExistingUnread,
      backgroundReplies,
      keepAwake,
      followupReply,
      followupCommitmentConfirmed,
      ...generationProfile
    } = profile;
    void webAutoSendOptIn;
    void autoOpenUnread;
    void includeExistingUnread;
    void backgroundReplies;
    void keepAwake;
    void followupReply;
    void followupCommitmentConfirmed;
    await this.call('/api/profiles', token, {
      profile: {
        ...generationProfile,
        replyMode:
          profile.replyMode === 'AUTO_REPLY_WEB'
            ? 'DRAFT_ONLY'
            : profile.replyMode,
      },
    });
  }
  async suggest(token: string, input: SuggestionRequest) {
    return SuggestionResponseSchema.parse(
      await this.call('/api/assist', token, input),
    );
  }
}
