import { describe, expect, it, vi } from 'vitest';
import {
  HttpLlmProvider,
  type GenerationInput,
} from '../src/providers/llm/provider.js';

const result = { reply: 'Hello!', needsHuman: false, evidenceIds: [] };
const input: GenerationInput = {
  provider: 'custom',
  model: 'org/model:free',
  apiKey: 'fixture-provider-key',
  system: 'Trusted business rules.',
  input: 'Customer text.',
  baseUrl: 'https://models.example.com/v1',
};
const envelope = (content = JSON.stringify(result)) => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
});

describe('OpenAI-compatible providers', () => {
  it.each([
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['deepseek', 'https://api.deepseek.com/chat/completions'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
    ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
    ['xai', 'https://api.x.ai/v1/chat/completions'],
    ['together', 'https://api.together.ai/v1/chat/completions'],
  ] as const)(
    'uses the fixed %s destination and JSON Chat Completions contract',
    async (provider, endpoint) => {
      const send = vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe(endpoint);
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('error');
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(new Headers(init.headers).get('Authorization')).toBe(
          `Bearer ${input.apiKey}`,
        );
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          model: input.model,
          stream: false,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system' },
            { role: 'user', content: input.input },
          ],
        });
        expect(String(init.body)).not.toContain(input.apiKey);
        return Response.json(envelope());
      });
      // Even a caller bypassing setup cannot override a preset's destination.
      await expect(
        new HttpLlmProvider(send).generate({ ...input, provider }),
      ).resolves.toEqual(result);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('appends the path to the canonical custom base and supports explicit text compatibility', async () => {
    const send = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://models.example.com/prefix/v1/chat/completions');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty('response_format');
      expect(String(init.body)).toContain('Return only a JSON object');
      return Response.json(envelope());
    });
    await expect(
      new HttpLlmProvider(send).generate({
        ...input,
        baseUrl: 'https://models.example.com/prefix/v1/',
        responseFormat: 'text',
      }),
    ).resolves.toEqual(result);
  });
  it.each([
    'http://models.example.com/v1',
    'https://127.0.0.1/v1',
    'https://models.example.com/v1?key=secret',
  ])(
    'rejects malformed custom endpoint %s before any network call',
    async (baseUrl) => {
      const send = vi.fn(async () => Response.json(envelope()));
      await expect(
        new HttpLlmProvider(send).generate({ ...input, baseUrl }),
      ).rejects.toThrow('ENDPOINT_REJECTED');
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each(['length', 'tool_calls', 'content_filter', 'error'])(
    'rejects an incomplete/unsafe finish reason: %s',
    async (finish_reason) => {
      const body = envelope();
      body.choices[0]!.finish_reason = finish_reason;
      await expect(
        new HttpLlmProvider(async () => Response.json(body)).generate(input),
      ).rejects.toThrow('INVALID_OUTPUT');
    },
  );
  it.each([
    { refusal: 'Cannot help' },
    { tool_calls: [{ id: 'call-1' }] },
    { function_call: { name: 'send_message' } },
    { content: null },
    { content: '```json\n{}\n```' },
    { content: '   ' },
  ])('rejects unsafe or malformed assistant content', async (message) => {
    const body = envelope();
    Object.assign(body.choices[0]!.message, message);
    await expect(
      new HttpLlmProvider(async () => Response.json(body)).generate(input),
    ).rejects.toThrow('INVALID_OUTPUT');
  });
  it('rejects multiple choices instead of selecting an ambiguous answer', async () => {
    const body = envelope();
    body.choices.push(...envelope().choices);
    await expect(
      new HttpLlmProvider(async () => Response.json(body)).generate(input),
    ).rejects.toThrow('INVALID_OUTPUT');
  });
  it('accepts explicit null tool and refusal metadata', async () => {
    const body = envelope();
    Object.assign(body.choices[0]!.message, {
      tool_calls: null,
      refusal: null,
    });
    await expect(
      new HttpLlmProvider(async () => Response.json(body)).generate(input),
    ).resolves.toEqual(result);
  });
  it.each([
    [401, 'KEY_REJECTED'],
    [429, 'RATE_LIMITED'],
    [400, 'MODEL_REJECTED'],
    [500, 'PROVIDER_UNAVAILABLE'],
  ] as const)(
    'sanitizes error %s and never retries at another destination',
    async (status, code) => {
      const send = vi.fn(
        async () =>
          new Response('private diagnostics and fixture-provider-key', {
            status,
          }),
      );
      await expect(new HttpLlmProvider(send).generate(input)).rejects.toThrow(
        code,
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds upstream JSON size', async () => {
    await expect(
      new HttpLlmProvider(async () => new Response('x'.repeat(65537))).generate(
        input,
      ),
    ).rejects.toThrow('INVALID_OUTPUT');
  });
});
