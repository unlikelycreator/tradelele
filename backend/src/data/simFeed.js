import { barStart } from '../lib/time.js';
import { aggregate } from './marketData.js';

// Approximate reference prices — only used to make the demo look realistic.
const BASE_PRICES = { BTC: 62000, ETH: 2500, SOL: 150, XRP: 0.6, BNB: 580, DOGE: 0.12, ADA: 0.38, AVAX: 27, LINK: 12, MATIC: 0.5, LTC: 70, DOT: 4.5, TRX: 0.16 };
const HISTORY_MINUTES = 300 * 60; // enough 1-minute bars for 300 candles of 60 minutes

/**
 * Synthetic 24×7 price generator for demos (DATA_SOURCE=sim). Each coin switches between
 * trending and choppy regimes every few hours, so the strategy has good and bad stretches.
 * Spot and futures of the same coin share one price path. NEVER use this to judge the
 * strategy — it is random.
 */
export class SimFeed {
  constructor({ marketData, tickMs = 1000, rng = Math.random }) {
    this.md = marketData;
    this.tickMs = tickMs;
    this.rng = rng;
    this.instruments = [];
    this.coins = new Map(); // base → { price, drift, vol, regimeUntil, bars: [1m bars], lastMs }
  }

  setInstruments(list) {
    this.instruments = list;
    for (const i of list) this.#coin(i.base);
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  #newRegime(c, ms) {
    const r = this.rng;
    const trending = r() < 0.45;
    c.drift = trending ? (r() < 0.5 ? -1 : 1) * (0.00002 + r() * 0.00005) : 0; // per minute (≈ 3–10% a day while trending)
    c.vol = 0.0006 + r() * 0.0006; // per-minute volatility (≈ 2.5–5% a day)
    c.regimeUntil = ms + (2 + r() * 6) * 3600_000;
  }

  /** Advance the price by `dtMs` of virtual time (drift and volatility scale with the step). */
  #step(c, ms, dtMs) {
    if (ms >= c.regimeUntil) this.#newRegime(c, ms);
    const m = dtMs / 60_000;
    const z = (this.rng() + this.rng() + this.rng() - 1.5) * 2; // ≈ N(0, 1)
    c.price *= 1 + c.drift * m + c.vol * Math.sqrt(m) * z;
    const start = barStart(ms, 1);
    const last = c.bars[c.bars.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, c.price);
      last.low = Math.min(last.low, c.price);
      last.close = c.price;
    } else {
      c.bars.push({ time: start, open: last ? last.close : c.price, high: c.price, low: c.price, close: c.price, volume: 1 + this.rng() * 10 });
      if (c.bars.length > HISTORY_MINUTES + 600) c.bars.splice(0, 600);
    }
  }

  /** Create a coin with a backfilled 1-minute history ending now. */
  #coin(base) {
    if (this.coins.has(base)) return this.coins.get(base);
    const now = this.md.clock.now().getTime();
    const c = { price: (BASE_PRICES[base] ?? 1 + this.rng() * 50) * (0.97 + this.rng() * 0.06), bars: [], regimeUntil: 0 };
    const start = barStart(now, 1) - HISTORY_MINUTES * 60_000;
    for (let ms = start; ms <= now; ms += 20_000) this.#step(c, ms, 20_000); // 3 steps per minute
    c.lastMs = now;
    this.coins.set(base, c);
    return c;
  }

  tick() {
    const now = this.md.clock.now().getTime();
    for (const c of this.coins.values()) {
      // one step per 5 virtual seconds since the last tick
      const span = now - c.lastMs;
      if (span <= 0) continue;
      const steps = Math.max(1, Math.round(span / 5000));
      for (let k = 1; k <= steps; k++) this.#step(c, c.lastMs + (span * k) / steps, span / steps);
      c.lastMs = now;
    }
    for (const i of this.instruments) {
      const c = this.coins.get(i.base);
      const dayAgo = c.bars[Math.max(0, c.bars.length - 1440)];
      const basis = i.kind === 'futures' ? 1.0003 : 1; // perps trade at a tiny premium
      this.md.pushTick(i.id, +(c.price * basis).toPrecision(8), { change24h: dayAgo ? +(((c.price - dayAgo.open) / dayAgo.open) * 100).toFixed(2) : null });
    }
  }

  async candles(inst, tf, limit) {
    const c = this.#coin(inst.base);
    const basis = inst.kind === 'futures' ? 1.0003 : 1;
    const bars = aggregate(c.bars.slice(-(limit + 2) * tf), tf, 1).slice(-limit);
    if (basis === 1) return bars.map((b) => ({ ...b }));
    return bars.map((b) => ({ ...b, open: b.open * basis, high: b.high * basis, low: b.low * basis, close: b.close * basis }));
  }

  status() {
    return { source: 'sim', lastError: null, instruments: this.instruments.length, speed: this.md.clock.speed };
  }
}
