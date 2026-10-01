/**
 * Sliding-window limiter enforcing both a per-second and a per-minute cap.
 * One limiter instance is shared by every endpoint in a group (orders / account / market data).
 */
export class RateLimiter {
  constructor({ perSecond, perMinute, name = 'limiter' }) {
    this.perSecond = perSecond;
    this.perMinute = perMinute;
    this.name = name;
    this.stamps = []; // request timestamps within the last minute
    this.queue = Promise.resolve();
    this.pausedUntil = 0;
  }

  /** Wait (FIFO) until a request is allowed, then record it. */
  acquire() {
    const next = this.queue.then(() => this.#waitForSlot());
    this.queue = next.catch(() => {});
    return next;
  }

  /** Back off the whole group, e.g. after an HTTP 429. */
  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  /** Delay (ms) until the next request would be allowed; 0 if now. */
  delayFor(now = Date.now()) {
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    let wait = Math.max(0, this.pausedUntil - now);
    const lastSecond = this.stamps.filter((t) => now - t < 1000);
    if (lastSecond.length >= this.perSecond) wait = Math.max(wait, lastSecond[0] + 1000 - now);
    if (this.stamps.length >= this.perMinute) wait = Math.max(wait, this.stamps[0] + 60_000 - now);
    return wait;
  }

  async #waitForSlot() {
    for (;;) {
      const wait = this.delayFor();
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait + 5));
    }
    this.stamps.push(Date.now());
  }

  usage(now = Date.now()) {
    this.delayFor(now);
    return {
      name: this.name,
      lastSecond: this.stamps.filter((t) => now - t < 1000).length,
      lastMinute: this.stamps.length,
      perSecond: this.perSecond,
      perMinute: this.perMinute,
    };
  }
}

// CoinDCX does not publish one clear table of per-endpoint limits, so the bot stays far
// below anything reasonable. A 429 pauses the whole group automatically.
export function createCoinDcxLimiters() {
  return {
    orders: new RateLimiter({ name: 'orders', perSecond: 4, perMinute: 90 }),
    account: new RateLimiter({ name: 'account', perSecond: 6, perMinute: 200 }),
    marketData: new RateLimiter({ name: 'marketData', perSecond: 6, perMinute: 200 }),
  };
}
