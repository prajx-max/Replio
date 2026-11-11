import {
  SettingsRepository,
  SETTINGS_KEY,
} from '../storage/settings-repository.js';
import { createMessageRouter } from './message-router.js';
import { AdapterRequestSchema } from '@assistant/contracts';
import { LiveController } from './live-controller.js';
import { reconnectWhatsApp } from './reconnect.js';
import { BackgroundRuntime } from './background-runtime.js';

const repository = new SettingsRepository(chrome.storage.local);
const background = new BackgroundRuntime(
  repository,
  chrome.storage.session,
  chrome,
  import.meta.env.MODE === 'fixture' ? 'http://127.0.0.1:4174' : undefined,
);
async function isActive(tabId: number) {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return active?.id === tabId;
}
function notifyStateChanged() {
  void chrome.runtime
    .sendMessage({ type: 'LIVE_STATE_CHANGED', version: 1 })
    .catch(() => undefined);
}
function reconcileBackground() {
  void background.reconcile().finally(notifyStateChanged);
}
const live = new LiveController(repository, chrome.storage.local, {
  isActive,
  isBackground: (tabId) => background.isBackground(tabId),
  reconnect: () =>
    reconnectWhatsApp(
      chrome,
      import.meta.env.MODE === 'fixture' ? 'http://127.0.0.1:4174' : undefined,
    ),
  send: async (tabId, message) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      (message.type === 'INSERT_APPROVED_DRAFT' ||
        message.type === 'SEND_AUTOMATIC_REPLY')
    ) {
      if (message.type === 'INSERT_APPROVED_DRAFT') {
        if (!(await isActive(tabId)))
          return { state: 'BLOCKED', reason: 'CONTEXT_CHANGED' };
      } else {
        const settings = await repository.load();
        const profile = settings.profiles.find(
          (item) => item.id === settings.activeProfileId,
        );
        const allowed = profile?.backgroundReplies
          ? await background.isBackground(tabId)
          : await isActive(tabId);
        if (
          !allowed ||
          !settings.enabled ||
          profile?.replyMode !== 'AUTO_REPLY_WEB' ||
          !profile.webAutoSendOptIn ||
          (await repository.load()).revision !== settings.revision
        )
          return { state: 'BLOCKED', reason: 'CONTEXT_CHANGED' };
      }
    }
    return chrome.tabs.sendMessage(tabId, message);
  },
  notify: notifyStateChanged,
});
const route = createMessageRouter(
  repository,
  chrome.storage.session,
  chrome.runtime.id,
  live,
  (settings) => background.inspect(settings),
);

chrome.runtime.onMessage.addListener((input: unknown, sender, respond) => {
  const adapterRequest = AdapterRequestSchema.safeParse(input);
  if (adapterRequest.success) {
    let trusted = false;
    try {
      const url = new URL(sender.url ?? '');
      trusted =
        sender.id === chrome.runtime.id &&
        sender.frameId === 0 &&
        sender.tab?.id !== undefined &&
        (url.origin === 'https://web.whatsapp.com' ||
          (import.meta.env.MODE === 'fixture' &&
            url.origin === 'http://127.0.0.1:4174'));
    } catch {
      /* Invalid sender URL is untrusted. */
    }
    if (!trusted || sender.tab?.id === undefined) {
      respond({ ok: false });
      return false;
    }
    const tabId = sender.tab.id;
    void live.handle(adapterRequest.data, tabId).then(
      (result) => {
        if (sender.tab?.active) live.selectTab(tabId);
        respond(result);
      },
      () => respond({ ok: false }),
    );
    return true;
  }
  void route(input, sender).then(respond, () =>
    respond({ ok: false, error: 'STORAGE_ERROR' }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  live.forget(tabId);
  reconcileBackground();
});
chrome.tabs.onActivated.addListener(({ tabId }) => live.selectTab(tabId));
chrome.tabs.onCreated.addListener(() => {
  reconcileBackground();
});
chrome.tabs.onUpdated.addListener(() => {
  reconcileBackground();
});
chrome.tabs.onReplaced.addListener((_added, removed) => {
  live.forget(removed);
  reconcileBackground();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_KEY in changes) reconcileBackground();
});
chrome.permissions.onAdded.addListener(() => {
  reconcileBackground();
});
chrome.permissions.onRemoved.addListener(() => {
  reconcileBackground();
});
reconcileBackground();
void chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(() => undefined);
// Reannounce a healthy observer after suspension. Resetting it here could
// baseline the very incoming message that woke this worker.
void reconnectWhatsApp(
  chrome,
  import.meta.env.MODE === 'fixture' ? 'http://127.0.0.1:4174' : undefined,
  'RESUME',
).catch(() => undefined);
chrome.runtime.onInstalled.addListener(() => {
  void repository.load().catch(() => {
    // Surface initialization errors through GET_STATE, without overwriting stored data.
  });
});
