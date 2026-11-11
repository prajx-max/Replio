import type { StorageArea } from '../src/storage/settings-repository.js';
import type { AssistantClient } from '../src/messaging/client.js';
import { SettingsRepository } from '../src/storage/settings-repository.js';
import { createMessageRouter } from '../src/background/message-router.js';

export const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
export const trustedSender = {
  id: extensionId,
  url: `chrome-extension://${extensionId}/sidepanel.html`,
  frameId: 0,
};
export class MemoryArea implements StorageArea {
  values: Record<string, unknown> = {};
  async get(key: string) {
    return structuredClone({ [key]: this.values[key] });
  }
  async set(values: Record<string, unknown>) {
    Object.assign(this.values, structuredClone(values));
  }
}
export function createHarness() {
  const local = new MemoryArea();
  const session = new MemoryArea();
  const repository = new SettingsRepository(local);
  const route = createMessageRouter(repository, session, extensionId);
  const client: AssistantClient = {
    async request(request) {
      const response = await route(request, trustedSender);
      if (!response.ok) throw new Error(response.error);
      return response.state;
    },
    subscribe: () => () => undefined,
  };
  return { local, session, repository, route, client };
}
