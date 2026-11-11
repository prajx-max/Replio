import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingPoll } from '../src/content/whatsapp/pending-poll.js';
import type { AdapterRequest } from '@assistant/contracts';
import { AdapterRequestSchema, selectorNames } from '@assistant/contracts';

const context = {
  profileId: 'fixture',
  chatKey: 'a'.repeat(64),
  contextId: 'active-chat',
  chatLabel: 'Fixture',
};
const incoming = {
  type: 'ADAPTER_MESSAGE',
  version: 1,
  context,
  eventKey: 'b'.repeat(64),
  text: 'Only this new text',
} as const;
const instances: PendingPoll[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
});
function setup() {
  const send = vi
    .fn<(request: AdapterRequest) => Promise<unknown>>()
    .mockResolvedValue({ ok: true, pollAfterMs: 1000 });
  const poll = new PendingPoll(send);
  instances.push(poll);
  return { send, poll };
}
describe('bounded pending-work transport rechecks', () => {
  it('sends only scoped metadata when the worker asks for rechecks, and stops after acknowledgement', async () => {
    const { poll, send } = setup();
    await poll.request(incoming);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send.mock.calls[1]?.[0]).toEqual({
      type: 'ADAPTER_POLL',
      version: 1,
      context,
    });
    expect(JSON.stringify(send.mock.calls[1])).not.toContain(incoming.text);
    send.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(count);
  });
  it.each([
    { ok: false },
    { ok: true },
    { ok: true, pollAfterMs: 0 },
    { ok: true, pollAfterMs: 60000 },
    null,
  ])(
    'does not poll for invalid or finished acknowledgements: %j',
    async (response) => {
      const { poll, send } = setup();
      send.mockResolvedValue(response);
      await poll.request(incoming);
      await vi.advanceTimersByTimeAsync(10000);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['cancel', 'stop'] as const)(
    'cancels pending callbacks on %s',
    async (method) => {
      const { poll, send } = setup();
      await poll.request(incoming);
      poll[method]();
      await vi.advanceTimersByTimeAsync(10000);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('does not revive a superseded polling loop after an old response arrives', async () => {
    const { poll, send } = setup();
    let finish: (response: unknown) => void = () => undefined;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = poll.request(incoming);
    send.mockResolvedValue({ ok: true });
    await poll.request({ ...incoming, eventKey: 'c'.repeat(64) });
    finish({ ok: true, pollAfterMs: 1000 });
    await old;
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('stops when the worker loses pending state or the bridge is disconnected', async () => {
    const { poll, send } = setup();
    await poll.request(incoming);
    send.mockResolvedValue({ ok: false });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockResolvedValue({ ok: true, pollAfterMs: 1000 });
    await poll.request(incoming);
    send.mockRejectedValue(new Error('Receiver removed'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('bounds polling to five minutes even if a broken worker keeps requesting it', async () => {
    const { poll, send } = setup();
    await poll.request(incoming);
    await vi.advanceTimersByTimeAsync(301000);
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(send).toHaveBeenCalledTimes(count);
    expect(count).toBeLessThanOrEqual(301);
  });
  it('does not send more customer text after disposal', async () => {
    const { poll, send } = setup();
    poll.stop();
    expect(await poll.request(incoming)).toEqual({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { ...context, contextId: 'new-context' },
    { ...context, profileId: 'another-business' },
    { ...context, chatKey: 'd'.repeat(64) },
  ])('cancels when status reports another context: %j', async (nextContext) => {
    const { poll, send } = setup();
    await poll.request(incoming);
    await poll.request(
      AdapterRequestSchema.parse({
        type: 'ADAPTER_STATUS',
        version: 1,
        status: {
          ready: true,
          context: nextContext,
          matches: Object.fromEntries(selectorNames.map((name) => [name, 0])),
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
