import { SettingsSchema } from '../messaging/contracts.js';
import type { Settings } from '../messaging/contracts.js';
import { defaultSettings } from '../background/mock-profile.js';
import {
  defaultSelectors,
  legacySelectors,
  selectorsV2,
  selectorsV3,
  selectorsV4,
  selectorsV5,
  selectorsV6,
} from '@assistant/contracts';

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
export const SETTINGS_KEY = 'assistant.settings.v1';

export class SettingsRepository {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly area: StorageArea) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<Settings> {
    const stored = (await this.area.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (stored !== undefined) {
      const settings = SettingsSchema.parse(stored);
      // Upgrade only the exact shipped pack; preserve all operator customizations.
      if (
        [
          legacySelectors,
          selectorsV2,
          selectorsV3,
          selectorsV4,
          selectorsV5,
          selectorsV6,
        ].some(
          (pack) => JSON.stringify(settings.selectors) === JSON.stringify(pack),
        )
      ) {
        const migrated = SettingsSchema.parse({
          ...settings,
          selectors: defaultSelectors,
          revision: settings.revision + 1,
        });
        await this.area.set({ [SETTINGS_KEY]: migrated });
        return migrated;
      }
      return settings;
    }
    const settings = defaultSettings();
    await this.area.set({ [SETTINGS_KEY]: settings });
    return settings;
  }

  load(): Promise<Settings> {
    return this.exclusive(() => this.read());
  }

  update(change: (settings: Settings) => Settings): Promise<Settings> {
    return this.exclusive(async () => {
      const current = await this.read();
      const next = SettingsSchema.parse({
        ...change(current),
        revision: current.revision + 1,
      });
      await this.area.set({ [SETTINGS_KEY]: next });
      return next;
    });
  }
}
