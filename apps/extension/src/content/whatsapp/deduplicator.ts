export class Deduplicator {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number) {}
  accept(key: string, now = Date.now()): boolean {
    for (const [id, time] of this.seen)
      if (now - time > this.windowMs) this.seen.delete(id);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.keys().next().value ?? '');
    return true;
  }
}
