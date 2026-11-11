import { z } from 'zod';
import type {
  SettingsRepository,
  StorageArea,
} from '../storage/settings-repository.js';
import type {
  BackgroundRuntimeStatus,
  Settings,
} from '../messaging/contracts.js';

export const BACKGROUND_TABS_KEY = 'assistant.backgroundTabs.v1';
const savedTabsSchema = z
  .array(
    z.strictObject({
      tabId: z.number().int().nonnegative(),
      autoDiscardable: z.boolean(),
    }),
  )
  .max(32);
interface RuntimeTab {
  id?: number | undefined;
  url?: string | undefined;
  pendingUrl?: string | undefined;
  discarded?: boolean | undefined;
  frozen?: boolean | undefined;
  autoDiscardable?: boolean | undefined;
}
export interface BackgroundApi {
  tabs: {
    query(query: { url: string[] }): Promise<RuntimeTab[]>;
    get(tabId: number): Promise<RuntimeTab>;
    update(
      tabId: number,
      changes: { autoDiscardable: boolean },
    ): Promise<unknown>;
  };
  permissions: {
    contains(request: { permissions: ['power'] }): Promise<boolean>;
  };
  power: { requestKeepAwake(level: 'system'): void; releaseKeepAwake(): void };
}
export function backgroundPolicy(settings: Settings) {
  const profile = settings.profiles.find(
    (item) => item.id === settings.activeProfileId,
  );
  return settings.enabled &&
    profile?.replyMode === 'AUTO_REPLY_WEB' &&
    profile.webAutoSendOptIn &&
    profile.backgroundReplies &&
    Boolean(settings.connections[profile.id]?.token)
    ? profile
    : null;
}

/** Only one loaded WhatsApp tab may own background work. This never activates a
 * tab, reloads a discarded document, changes a URL or reads a closed chat. */
export class BackgroundRuntime {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly origins: string[];
  constructor(
    private readonly repository: SettingsRepository,
    private readonly session: StorageArea,
    private readonly api: BackgroundApi,
    fixtureOrigin?: 'http://127.0.0.1:4174',
  ) {
    this.origins = [
      'https://web.whatsapp.com',
      ...(fixtureOrigin ? [fixtureOrigin] : []),
    ];
  }
  private async recognizedTabs(): Promise<RuntimeTab[]> {
    return (
      await this.api.tabs.query({
        url: this.origins.map((origin) => `${origin}/*`),
      })
    ).filter((tab) => {
      try {
        return (
          tab.id !== undefined &&
          this.origins.includes(new URL(tab.url ?? '').origin)
        );
      } catch {
        return false;
      }
    });
  }
  private async soleTab(): Promise<RuntimeTab | null> {
    const tabs = await this.recognizedTabs();
    if (tabs.length !== 1) return null;
    const tab = tabs[0];
    return tab && !tab.discarded && !tab.frozen && !tab.pendingUrl ? tab : null;
  }
  /** Read-only explanation for the operator. This is never an authorization
   * token and contains no tab identifiers, URLs, conversation data or secrets. */
  async inspect(settings: Settings): Promise<BackgroundRuntimeStatus> {
    try {
      const tabs = await this.recognizedTabs();
      const tabCount = Math.min(tabs.length, 10000);
      const state = (value: BackgroundRuntimeStatus['state']) => ({
        state: value,
        tabCount,
      });
      if ((await this.repository.load()).revision !== settings.revision)
        return state('SETTINGS_CHANGED');
      const profile = settings.profiles.find(
        (item) => item.id === settings.activeProfileId,
      );
      if (!profile) return state('CHECK_FAILED');
      if (!settings.enabled) return state('ASSISTANT_DISABLED');
      if (profile.replyMode !== 'AUTO_REPLY_WEB' || !profile.webAutoSendOptIn)
        return state('AUTO_REPLY_DISABLED');
      if (!profile.backgroundReplies) return state('BACKGROUND_DISABLED');
      if (!settings.connections[profile.id]?.token)
        return state('BACKEND_DISCONNECTED');
      if (!tabs.length) return state('NO_WHATSAPP_TAB');
      if (tabs.length !== 1) return state('MULTIPLE_WHATSAPP_TABS');
      const tab = tabs[0];
      if (!tab) return state('CHECK_FAILED');
      if (tab.discarded) return state('TAB_DISCARDED');
      if (tab.frozen) return state('TAB_FROZEN');
      if (tab.pendingUrl) return state('TAB_NAVIGATING');
      return state('READY');
    } catch {
      return { state: 'CHECK_FAILED', tabCount: null };
    }
  }
  async isBackground(tabId: number): Promise<boolean> {
    try {
      const initial = await this.repository.load();
      if (!backgroundPolicy(initial)) return false;
      const tab = await this.soleTab();
      const current = await this.repository.load();
      return (
        tab?.id === tabId &&
        current.revision === initial.revision &&
        Boolean(backgroundPolicy(current))
      );
    } catch {
      return false;
    }
  }
  reconcile(): Promise<void> {
    const next = this.queue.then(
      () => this.apply(),
      () => this.apply(),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }
  private releasePower() {
    try {
      this.api.power.releaseKeepAwake();
    } catch {
      /* No permission or unloaded extension. */
    }
  }
  private async apply(): Promise<void> {
    try {
      const initial = await this.repository.load();
      const profile = backgroundPolicy(initial);
      const candidate = profile ? await this.soleTab() : null;
      const current = await this.repository.load();
      const target = current.revision === initial.revision ? candidate : null;
      const raw = (await this.session.get(BACKGROUND_TABS_KEY))[
        BACKGROUND_TABS_KEY
      ];
      const saved = savedTabsSchema.parse(raw ?? []);
      const retained: z.infer<typeof savedTabsSchema> = [];
      for (const entry of saved) {
        if (entry.tabId === target?.id) {
          retained.push(entry);
          continue;
        }
        try {
          await this.api.tabs.update(entry.tabId, {
            autoDiscardable: entry.autoDiscardable,
          });
        } catch {
          // Retain a failed restoration while its tab still exists, so a later
          // event or worker recreation can retry. Closed tabs need no restore.
          try {
            await this.api.tabs.get(entry.tabId);
            retained.push(entry);
          } catch {
            /* Tab closed. */
          }
        }
      }
      if (
        target?.id !== undefined &&
        !retained.some((entry) => entry.tabId === target.id) &&
        retained.length < 32 &&
        target.autoDiscardable !== undefined
      ) {
        retained.push({
          tabId: target.id,
          autoDiscardable: target.autoDiscardable,
        });
      }
      // Save original values before changing the tab; a worker restart can then
      // restore them even if the previous worker stopped after tabs.update.
      await this.session.set({ [BACKGROUND_TABS_KEY]: retained });
      if (
        target?.id !== undefined &&
        target.autoDiscardable !== false &&
        retained.some((entry) => entry.tabId === target.id)
      )
        await this.api.tabs.update(target.id, { autoDiscardable: false });
      const latest = await this.repository.load();
      if (
        target &&
        latest.revision === initial.revision &&
        backgroundPolicy(latest)?.keepAwake &&
        (await this.api.permissions.contains({ permissions: ['power'] }))
      ) {
        // Recheck after the asynchronous permission lookup before taking the lock.
        const final = await this.repository.load();
        if (
          final.revision === initial.revision &&
          backgroundPolicy(final)?.keepAwake
        ) {
          this.api.power.requestKeepAwake('system');
          return;
        }
      }
      this.releasePower();
    } catch {
      // Failed settings/storage/tab checks never create a power request.
      this.releasePower();
    }
  }
}
