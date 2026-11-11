import { AdapterAckSchema } from '@assistant/contracts';
import type { AdapterContext, AdapterRequest } from '@assistant/contracts';

/** Transport-only rechecks requested by the worker. No message rereads, timers
 * in the worker, persistent conversation text or history replay are needed. */
export class PendingPoll {
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private context: AdapterContext | undefined;
  private startedAt = 0;
  private stopped = false;
  constructor(
    private readonly send: (request: AdapterRequest) => Promise<unknown>,
  ) {}

  cancel() {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.context = undefined;
  }
  stop() {
    this.stopped = true;
    this.cancel();
  }
  async request(request: AdapterRequest): Promise<unknown> {
    if (this.stopped) return { ok: false };
    if (
      request.type === 'ADAPTER_STATUS' &&
      this.context &&
      (request.status.context?.contextId !== this.context.contextId ||
        request.status.context.profileId !== this.context.profileId ||
        request.status.context.chatKey !== this.context.chatKey)
    )
      this.cancel();
    if (request.type === 'ADAPTER_MESSAGE') {
      this.cancel();
      this.context = request.context;
      this.startedAt = Date.now();
    }
    const epoch = this.epoch;
    const response = await this.send(request);
    if (request.type === 'ADAPTER_MESSAGE')
      this.schedule(request.context, response, epoch);
    return response;
  }
  private schedule(context: AdapterContext, raw: unknown, epoch: number) {
    const parsed = AdapterAckSchema.safeParse(raw);
    if (
      this.stopped ||
      epoch !== this.epoch ||
      !parsed.success ||
      !parsed.data.ok ||
      parsed.data.pollAfterMs === undefined ||
      Date.now() - this.startedAt >= 300000
    )
      return;
    this.timer = setTimeout(() => {
      if (this.stopped || epoch !== this.epoch) return;
      void this.send({ type: 'ADAPTER_POLL', version: 1, context }).then(
        (response) => this.schedule(context, response, epoch),
        () => undefined,
      );
    }, parsed.data.pollAfterMs);
  }
}
