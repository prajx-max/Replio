import {
  AdapterConfigSchema,
  AdapterControlSchema,
} from '@assistant/contracts';
import { WhatsAppAdapter } from './adapter.js';
import { PendingPoll } from './pending-poll.js';

let adapter: WhatsAppAdapter | null = null;
let pending = Promise.resolve();
let disposed = false;
const bridge = globalThis as typeof globalThis & {
  __universalAssistantDispose?: () => void;
};
// Re-injection replaces an old bridge instead of installing another observer.
bridge.__universalAssistantDispose?.();
const polling = new PendingPoll((request) =>
  chrome.runtime.sendMessage(request),
);
async function initialize(rebaseline: boolean) {
  if (rebaseline) polling.cancel();
  if (disposed) return;
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'ADAPTER_BOOTSTRAP',
    version: 1,
  });
  const parsed = AdapterConfigSchema.safeParse(response);
  if (!parsed.success || disposed)
    throw new Error('Adapter initialization failed');
  const config = {
    ...parsed.data,
    buildVersion: chrome.runtime.getManifest().version,
  };
  if (adapter) {
    if (rebaseline) await adapter.configure(config);
    else await adapter.resume(config);
  } else {
    adapter = new WhatsAppAdapter(document, config, (request) =>
      polling.request(request),
    );
    await adapter.start();
  }
}
function reset(rebaseline = true) {
  const result = pending.then(
    () => initialize(rebaseline),
    () => initialize(rebaseline),
  );
  pending = result.catch(() => undefined);
  return result;
}
const receive: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
  input: unknown,
  sender,
  respond,
) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('service-worker.js')
  )
    return false;
  const control = AdapterControlSchema.safeParse(input);
  if (control.success) {
    void reset(control.data.type === 'ADAPTER_RESET').then(
      () => respond({ ok: true }),
      () => respond({ ok: false }),
    );
    return true;
  }
  if (!adapter) {
    respond({ ok: false });
    return false;
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'SEND_AUTOMATIC_REPLY'
  )
    void adapter
      .autoSend(input)
      .then(respond, () =>
        respond({ state: 'UNCERTAIN', reason: 'SEND_UNCONFIRMED' }),
      );
  else
    void adapter.insert(input).then(
      (ok) => respond({ ok }),
      () => respond({ ok: false }),
    );
  return true;
};
chrome.runtime.onMessage.addListener(receive);
bridge.__universalAssistantDispose = () => {
  disposed = true;
  polling.stop();
  adapter?.stop();
  try {
    chrome.runtime.onMessage.removeListener(receive);
  } catch {
    /* Old extension context already invalidated. */
  }
};
void reset().catch(() => {
  /* Extension reload/offline is surfaced by worker diagnostics. */
});
