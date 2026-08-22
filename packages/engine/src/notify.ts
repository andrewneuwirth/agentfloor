import type { EventSeverity, Notifier } from "./types.js";

/**
 * Wraps a notifier so identical messages within a window are sent once.
 * A budget-capped floor re-skips every tick; the human needs one alert,
 * not one per tick.
 */
export class ThrottledNotifier implements Notifier {
  readonly name: string;
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly inner: Notifier,
    private readonly windowSeconds = 1800,
  ) {
    this.name = inner.name;
  }

  async notify(message: string, opts?: { severity?: EventSeverity }): Promise<void> {
    const now = Date.now();
    const prev = this.lastSent.get(message);
    if (prev != null && now - prev < this.windowSeconds * 1000) return;
    this.lastSent.set(message, now);
    // keep the dedupe map from growing unbounded
    if (this.lastSent.size > 500) {
      for (const [k, t] of this.lastSent) if (now - t > this.windowSeconds * 1000) this.lastSent.delete(k);
    }
    await this.inner.notify(message, opts);
  }
}
