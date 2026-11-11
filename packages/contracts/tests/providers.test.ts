import { describe, expect, it } from 'vitest';
import {
  CustomProviderBaseUrlSchema,
  ProviderConfigurationSchema,
} from '../src/index.js';

const config = {
  profileId: 'business',
  provider: 'custom',
  model: 'vendor/model:free',
  baseUrl: 'https://models.vendor.com/api/v1',
};

describe('provider configuration boundary', () => {
  it('accepts base64 bearer-token characters while rejecting header injection and embedded whitespace', () => {
    expect(
      ProviderConfigurationSchema.safeParse({
        ...config,
        apiKey: 'fixture+token/value==',
      }).success,
    ).toBe(true);
    for (const apiKey of [
      'key\r\nHeader: forged',
      'key with spaces',
      'key\u0000control',
      'short',
    ])
      expect(
        ProviderConfigurationSchema.safeParse({ ...config, apiKey }).success,
      ).toBe(false);
  });
  it('canonicalizes a custom destination before credential reuse checks', () => {
    expect(
      CustomProviderBaseUrlSchema.parse(
        ' HTTPS://Models.Vendor.com:443/api/v1/// ',
      ),
    ).toBe(config.baseUrl);
    expect(
      ProviderConfigurationSchema.parse({ ...config, responseFormat: 'text' }),
    ).toMatchObject(config);
  });
  it.each([
    'http://models.vendor.com/v1',
    'https://localhost/v1',
    'https://api.local/v1',
    'https://api.internal/v1',
    'https://127.0.0.1/v1',
    'https://2130706433/v1',
    'https://[::1]/v1',
    'https://[2606:4700::1111]/v1',
    'https://models.vendor.com:8443/v1',
    'https://user:secret@models.vendor.com/v1',
    'https://models.vendor.com/v1?key=secret',
    'https://models.vendor.com/v1?',
    'https://models.vendor.com/v1#',
    'https://models.vendor.com/v1/chat/completions/',
    'https://models.vendor.com/v1%2fadmin',
    'https://models.vendor.com\\@localhost/v1',
    'https://models.vendor.com/\nadmin',
    'https://models.vendor.com./v1',
    'https://models.vendor.com/v1/../v2',
  ])('rejects unsafe or ambiguous custom API base %s', (baseUrl) => {
    expect(
      ProviderConfigurationSchema.safeParse({ ...config, baseUrl }).success,
    ).toBe(false);
  });
  it.each([
    { ...config, baseUrl: undefined },
    { ...config, provider: 'groq' },
    { ...config, provider: 'openai' },
    { ...config, responseFormat: 'yaml' },
    {
      profileId: 'business',
      provider: 'gemini',
      model: 'model',
      responseFormat: 'text',
    },
  ])('rejects options incompatible with the selected protocol', (input) => {
    expect(ProviderConfigurationSchema.safeParse(input).success).toBe(false);
  });
  it.each(['groq', 'deepseek', 'openrouter', 'mistral', 'xai', 'together'])(
    'accepts %s with an operator-selected model and JSON mode',
    (provider) => {
      expect(
        ProviderConfigurationSchema.safeParse({
          profileId: 'business',
          provider,
          model: 'vendor/model',
          responseFormat: 'json_object',
        }).success,
      ).toBe(true);
    },
  );
});
