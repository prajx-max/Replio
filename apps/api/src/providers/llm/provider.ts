import { z } from 'zod';
import {
  CustomProviderBaseUrlSchema,
  type Provider,
} from '@assistant/contracts';
import { ServiceFailure } from './failure.js';
import { customProviderFetch } from './public-endpoint.js';
export { ServiceFailure } from './failure.js';
export interface GenerationInput {
  provider: Provider;
  model: string;
  apiKey: string;
  system: string;
  input: string;
  baseUrl?: string;
  responseFormat?: 'json_object' | 'text';
}
export interface LlmProvider {
  generate(input: GenerationInput): Promise<unknown>;
}
export type ProviderFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
    needsHuman: { type: 'boolean' },
    evidenceIds: {
      type: 'array',
      items: { type: 'string', enum: ['business-information'] },
    },
  },
  required: ['reply', 'needsHuman', 'evidenceIds'],
};
const textPart = z.object({
  type: z.string().optional(),
  text: z.string().max(16000),
});
const openAiOutput = z.object({
  status: z.string().optional(),
  output: z.array(z.object({ content: z.array(textPart).optional() })),
});
const geminiOutput = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(textPart) }) }))
    .min(1),
});
const anthropicOutput = z.object({ content: z.array(textPart) });
const compatibleOutput = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().trim().min(1).max(16000),
          refusal: z.null().optional(),
          tool_calls: z.array(z.never()).max(0).nullable().optional(),
          function_call: z.null().optional(),
        }),
      }),
    )
    .length(1),
});
const compatibleEndpoints = {
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com',
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.ai/v1',
} as const;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ServiceFailure('INVALID_OUTPUT');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new ServiceFailure('INVALID_OUTPUT');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ServiceFailure('INVALID_OUTPUT');
  }
}
export class HttpLlmProvider implements LlmProvider {
  constructor(private readonly request?: ProviderFetch) {}
  async generate(input: GenerationInput): Promise<unknown> {
    let url: string;
    let headers: Record<string, string>;
    let body: unknown;
    if (input.provider === 'openai') {
      url = 'https://api.openai.com/v1/responses';
      headers = { Authorization: `Bearer ${input.apiKey}` };
      body = {
        model: input.model,
        instructions: input.system,
        input: input.input,
        store: false,
        max_output_tokens: 2000,
        text: {
          format: {
            type: 'json_schema',
            name: 'business_reply',
            strict: true,
            schema: outputSchema,
          },
        },
      };
    } else if (input.provider === 'gemini') {
      const model = input.model.replace(/^models\//, '');
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      headers = { 'x-goog-api-key': input.apiKey };
      body = {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: input.input }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 2000,
        },
      };
    } else if (input.provider === 'anthropic') {
      url = 'https://api.anthropic.com/v1/messages';
      headers = {
        Authorization: `Bearer ${input.apiKey}`,
        'anthropic-version': '2026-10-21',
      };
      body = {
        model: input.model,
        max_tokens: 2000,
        system: input.system,
        messages: [{ role: 'user', content: input.input }],
        output_config: {
          format: { type: 'json_schema', schema: outputSchema },
        },
      };
    } else {
      const parsed =
        input.provider === 'custom'
          ? CustomProviderBaseUrlSchema.safeParse(input.baseUrl)
          : undefined;
      if (input.provider === 'custom' && !parsed?.success)
        throw new ServiceFailure('ENDPOINT_REJECTED');
      const base =
        input.provider === 'custom'
          ? parsed?.data
          : compatibleEndpoints[input.provider];
      if (!base) throw new ServiceFailure('INVALID_REQUEST');
      url = `${base}/chat/completions`;
      headers = { Authorization: `Bearer ${input.apiKey}` };
      body = {
        model: input.model,
        messages: [
          {
            role: 'system',
            content: `${input.system}\nReturn only a JSON object with exactly these fields: reply (string), needsHuman (boolean), evidenceIds (array containing only "business-information" or empty). Do not include Markdown fences.`,
          },
          { role: 'user', content: input.input },
        ],
        stream: false,
        max_tokens: 2000,
        ...(input.responseFormat === 'text'
          ? {}
          : { response_format: { type: 'json_object' } }),
      };
    }
    try {
      const send =
        this.request ??
        (input.provider === 'custom' ? customProviderFetch : fetch);
      const response = await send(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ServiceFailure(
          response.status === 401 || response.status === 403
            ? 'KEY_REJECTED'
            : response.status === 429
              ? 'RATE_LIMITED'
              : response.status === 400 || response.status === 404
                ? 'MODEL_REJECTED'
                : 'PROVIDER_UNAVAILABLE',
        );
      }
      const json = await boundedJson(response);
      let text: string;
      if (input.provider === 'openai') {
        const parsed = openAiOutput.parse(json);
        if (parsed.status && parsed.status !== 'completed')
          throw new ServiceFailure('INVALID_OUTPUT');
        text = parsed.output
          .flatMap((item) => item.content ?? [])
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text)
          .join('');
      } else if (input.provider === 'gemini') {
        text =
          geminiOutput
            .parse(json)
            .candidates[0]?.content.parts.map((part) => part.text)
            .join('') ?? '';
      } else if (input.provider === 'anthropic')
        text = anthropicOutput
          .parse(json)
          .content.filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('');
      else
        text = compatibleOutput.parse(json).choices[0]?.message.content ?? '';
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof ServiceFailure) throw error;
      throw new ServiceFailure(
        error instanceof SyntaxError || error instanceof z.ZodError
          ? 'INVALID_OUTPUT'
          : 'PROVIDER_UNAVAILABLE',
      );
    }
  }
}
