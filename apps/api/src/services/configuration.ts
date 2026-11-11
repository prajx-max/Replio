import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ProviderConfigurationSchema } from '@assistant/contracts';
import type {
  BusinessProfile,
  Provider,
  ProviderConfiguration,
} from '@assistant/contracts';
import { ServiceFailure } from '../providers/llm/provider.js';
import { readConnections, writeConnections } from './connection-file.js';
import type { SavedConnection } from './connection-file.js';

interface Configuration {
  profileId: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  responseFormat?: 'json_object' | 'text';
  token: string;
  environmentKey: string;
  remembered: boolean;
}
export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class ConfigurationStore {
  private readonly namespace = randomBytes(12).toString('hex');
  private readonly configurations = new Map<string, Configuration>();
  readonly profiles = new Map<string, BusinessProfile>();
  constructor(private readonly connectionFile?: string) {
    if (connectionFile) {
      for (const entry of readConnections(connectionFile)) {
        const environmentKey = this.keyName(entry.profileId);
        process.env[environmentKey] = entry.apiKey;
        this.configurations.set(entry.profileId, {
          profileId: entry.profileId,
          provider: entry.provider,
          model: entry.model,
          ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          ...(entry.responseFormat
            ? { responseFormat: entry.responseFormat }
            : {}),
          token: entry.token,
          environmentKey,
          remembered: true,
        });
      }
    }
  }
  private keyName(profileId: string) {
    return `ASSISTANT_KEY_${createHash('sha256').update(`${this.namespace}:${profileId}`).digest('hex').slice(0, 24)}`;
  }
  private persist(
    next: Map<string, Configuration>,
    replacement?: { environmentKey: string; apiKey: string },
  ) {
    if (!this.connectionFile)
      throw new ServiceFailure('CONFIGURATION_SAVE_FAILED');
    const saved: SavedConnection[] = [];
    for (const config of next.values()) {
      if (!config.remembered) continue;
      const apiKey =
        replacement?.environmentKey === config.environmentKey
          ? replacement.apiKey
          : process.env[config.environmentKey];
      if (!apiKey) throw new ServiceFailure('CONFIGURATION_SAVE_FAILED');
      saved.push({
        profileId: config.profileId,
        provider: config.provider,
        model: config.model,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.responseFormat
          ? { responseFormat: config.responseFormat }
          : {}),
        apiKey,
        token: config.token,
      });
    }
    writeConnections(this.connectionFile, saved);
  }
  configure(input: ProviderConfiguration) {
    const config = ProviderConfigurationSchema.parse(input);
    const previous = this.configurations.get(config.profileId);
    const environmentKey = this.keyName(config.profileId);
    if (
      !config.apiKey &&
      (!previous ||
        previous.provider !== config.provider ||
        previous.baseUrl !== config.baseUrl ||
        !process.env[environmentKey])
    )
      throw new ServiceFailure('NOT_CONFIGURED');
    const current: Configuration = {
      profileId: config.profileId,
      provider: config.provider,
      model: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.responseFormat
        ? { responseFormat: config.responseFormat }
        : {}),
      token: previous?.token ?? randomBytes(32).toString('base64url'),
      environmentKey,
      remembered: config.remember ?? previous?.remembered ?? false,
    };
    if (current.remembered || previous?.remembered) {
      const next = new Map(this.configurations);
      next.set(config.profileId, current);
      this.persist(
        next,
        config.apiKey ? { environmentKey, apiKey: config.apiKey } : undefined,
      );
    }
    if (config.apiKey) process.env[environmentKey] = config.apiKey;
    this.configurations.set(config.profileId, current);
    return this.describe(config.profileId);
  }
  describe(profileId: string) {
    const config = this.configurations.get(profileId);
    return {
      configured: Boolean(config && process.env[config.environmentKey]),
      provider: config?.provider ?? null,
      model: config?.model ?? '',
      baseUrl: config?.baseUrl ?? '',
      responseFormat: config?.responseFormat ?? 'json_object',
      pairingCode: config?.token ?? '',
      remembered: config?.remembered ?? false,
      persistenceAvailable: Boolean(this.connectionFile),
    };
  }
  authorize(token: string): Configuration | null {
    for (const config of this.configurations.values())
      if (token && sameSecret(token, config.token)) return config;
    return null;
  }
  generation(config: Configuration) {
    // An HTTP handler can await request data after authorization. Never combine
    // that old destination with a replacement key from a subsequent setup save.
    if (this.configurations.get(config.profileId) !== config)
      throw new ServiceFailure('NOT_CONFIGURED');
    const apiKey = process.env[config.environmentKey];
    if (!apiKey) throw new ServiceFailure('NOT_CONFIGURED');
    return {
      provider: config.provider,
      model: config.model,
      apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.responseFormat
        ? { responseFormat: config.responseFormat }
        : {}),
    };
  }
  clear(profileId: string) {
    const config = this.configurations.get(profileId);
    if (config?.remembered) {
      const next = new Map(this.configurations);
      next.delete(profileId);
      this.persist(next);
    }
    if (config) delete process.env[config.environmentKey];
    this.configurations.delete(profileId);
    this.profiles.delete(profileId);
  }
  close() {
    for (const config of this.configurations.values())
      delete process.env[config.environmentKey];
    this.configurations.clear();
    this.profiles.clear();
  }
}
