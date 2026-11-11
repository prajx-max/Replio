import { ShellRequestSchema, ShellResponseSchema } from './contracts.js';
import type { ErrorCode, ShellRequest, ShellState } from './contracts.js';

const messages: Record<ErrorCode, string> = {
  WHATSAPP_UNAVAILABLE:
    'Open WhatsApp Web in this Chrome profile. Allow the extension on web.whatsapp.com, then click Reconnect WhatsApp.',
  UNAUTHORIZED: 'This action is available only from the extension.',
  INVALID_REQUEST: 'That change is invalid. Check your fields and try again.',
  STORAGE_ERROR:
    'Settings could not be read or saved. Reopen the extension and try again. Existing data has been kept.',
  PROFILE_CHANGED:
    'The active business changed. Reload this page before continuing.',
  DISABLED:
    'Enable the assistant and choose draft-only mode to run the sample.',
  CONFLICT:
    'Settings changed in another window. Reload this page to review the latest version before saving.',
  UNAVAILABLE: 'This sample is available only for the sample bakery profile.',
  BACKEND_ERROR:
    'Could not connect to the AI backend. Start it, configure a model key, and check the pairing code.',
  STALE_DRAFT:
    'The chat, profile or settings changed. Generate a fresh suggestion before inserting.',
  COMPOSER_BUSY:
    'The draft was not inserted. Check the active chat and clear any text already in the WhatsApp composer.',
};
export interface AssistantClient {
  request(request: ShellRequest): Promise<ShellState>;
  subscribe(onChange: () => void): () => void;
}
export const assistantClient: AssistantClient = {
  async request(input) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id)
      throw new Error(
        'Load this folder as a Chrome extension to use the assistant.',
      );
    const request = ShellRequestSchema.parse(input);
    let response: unknown;
    try {
      response = await chrome.runtime.sendMessage(request);
    } catch {
      throw new Error(
        'The service worker is unavailable. Reload the extension in chrome://extensions and try again.',
      );
    }
    const parsed = ShellResponseSchema.safeParse(response);
    if (!parsed.success)
      throw new Error(
        'The extension returned an invalid response. Reload the extension and try again.',
      );
    if (!parsed.data.ok) throw new Error(messages[parsed.data.error]);
    return parsed.data.state;
  },
  subscribe(onChange) {
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged)
      return () => undefined;
    const listener = (
      _changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === 'local' || area === 'session') onChange();
    };
    chrome.storage.onChanged.addListener(listener);
    const runtimeListener = (
      input: unknown,
      sender: chrome.runtime.MessageSender,
    ) => {
      if (
        sender.id === chrome.runtime.id &&
        typeof input === 'object' &&
        input !== null &&
        'type' in input &&
        input.type === 'LIVE_STATE_CHANGED'
      )
        onChange();
      return false;
    };
    chrome.runtime.onMessage.addListener(runtimeListener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
      chrome.runtime.onMessage.removeListener(runtimeListener);
    };
  },
};
