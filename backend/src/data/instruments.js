import { log } from '../lib/bus.js';

/**
 * Tradable instruments. Every price, order and trade refers to an instrument id:
 *   'S:BTCUSDT'     → CoinDCX spot market BTCUSDT (long only)
 *   'F:B-BTC_USDT'  → CoinDCX USDT-margined perpetual future (long + short)
 */
export const instId = (kind, symbol) => `${kind === 'futures' ? 'F' : 'S'}:${symbol}`;

export function parseInstId(id) {
  const [k, ...rest] = String(id).split(':');
  return { kind: k === 'F' ? 'futures' : 'spot', symbol: rest.join(':') };
}

/** 'BTCUSDT' → 'BTC', 'B-BTC_USDT' → 'BTC' */
export function baseOf(kind, symbol) {
  if (kind === 'futures') return symbol.replace(/^[A-Z]+-/, '').split('_')[0];
  return symbol.replace(/USDT$/, '');
}

export function labelOf(kind, symbol) {
  return kind === 'futures' ? `${baseOf(kind, symbol)}-PERP` : `${baseOf(kind, symbol)}/USDT`;
}

/** Number of decimals in a step like 0.001 / 0.5 / 1e-7. */
export function decimalsOf(step) {
  const s = String(Number(Number(step).toPrecision(12)));
  const m = s.match(/e-(\d+)$/);
  if (m) return Number(m[1]) + ((s.split('e')[0].split('.')[1] || '').length);
  return (s.split('.')[1] || '').length;
}
const fromPrecision = (p) => (p == null || p === '' ? null : 10 ** -Number(p));
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Rough tick/step defaults from a price, used until (or if) exchange rules load. */
export function defaultSpecs(price) {
  const p = price > 0 ? price : 100;
  const clean = (x) => Number(x.toPrecision(6));
  const tick = clean(10 ** Math.floor(Math.log10(p) - 4));
  const qtyStep = clean(Math.min(1, 10 ** Math.floor(Math.log10(10 / p))));
  return { tick, qtyStep, minQty: qtyStep, minNotional: 5 };
}

/** Round down to the quantity step (never order more than sized). */
export function floorQty(inst, qty) {
  const step = inst.qtyStep;
  const v = Math.floor(qty / step + 1e-9) * step;
  return +v.toFixed(decimalsOf(step));
}

/** Round a price to the instrument tick ('down' / 'up' / 'nearest'). */
export function roundPrice(inst, price, dir = 'nearest') {
  const t = inst.tick;
  const x = price / t;
  const n = dir === 'down' ? Math.floor(x + 1e-9) : dir === 'up' ? Math.ceil(x - 1e-9) : Math.round(x);
  return +(n * t).toFixed(decimalsOf(t));
}

export class InstrumentRegistry {
  constructor({ client }) {
    this.client = client; // null in simulator mode
    this.map = new Map();
    this.loadedRules = false;
  }

  get(id) {
    return this.map.get(id);
  }

  list() {
    return [...this.map.values()];
  }

  /** Build the instrument list for the current settings (and fetch exchange rules when possible). */
  async sync(settings, priceOf = () => null) {
    const wanted = [];
    if (settings.market !== 'futures') for (const s of settings.spotSymbols) wanted.push(['spot', s]);
    if (settings.market !== 'spot') for (const s of settings.futuresPairs) wanted.push(['futures', s]);
    const next = new Map();
    for (const [kind, symbol] of wanted) {
      const id = instId(kind, symbol);
      const prev = this.map.get(id);
      next.set(
        id,
        prev || {
          id,
          kind,
          symbol,
          base: baseOf(kind, symbol),
          label: labelOf(kind, symbol),
          candlePair: kind === 'futures' ? symbol : `B-${baseOf(kind, symbol)}_USDT`,
          stopLimit: kind === 'spot', // refined from markets_details below
          maxLeverage: null,
          rules: 'default',
          ...defaultSpecs(priceOf(id)),
        },
      );
    }
    this.map = next;
    if (this.client) await this.#loadRules();
  }

  /** Re-derive default tick/step once a first price is known (only for instruments without exchange rules). */
  refineDefaults(id, price) {
    const i = this.map.get(id);
    if (i && i.rules === 'default' && !i.priced && price > 0) Object.assign(i, defaultSpecs(price), { priced: true });
  }

  async #loadRules() {
    const spot = this.list().filter((i) => i.kind === 'spot' && i.rules === 'default');
    if (spot.length) {
      try {
        const details = await this.client.spotMarketsDetails();
        for (const inst of spot) {
          const d = details.find((x) => (x.coindcx_name || x.symbol) === inst.symbol);
          if (!d) {
            log('warn', `${inst.symbol}: not found in CoinDCX spot markets — check the symbol`);
            continue;
          }
          Object.assign(inst, {
            candlePair: d.pair || inst.candlePair,
            tick: num(d.step) || fromPrecision(d.base_currency_precision) || inst.tick,
            qtyStep: fromPrecision(d.target_currency_precision) || inst.qtyStep,
            minQty: num(d.min_quantity) || inst.minQty,
            minNotional: num(d.min_notional) || inst.minNotional,
            stopLimit: Array.isArray(d.order_types) ? d.order_types.includes('stop_limit') : false,
            active: d.status ? d.status === 'active' : true,
            rules: 'exchange',
          });
        }
      } catch (e) {
        log('warn', `Could not load spot market rules (${e.message}) — using estimated tick/step sizes`);
      }
    }
    for (const inst of this.list().filter((i) => i.kind === 'futures' && i.rules === 'default')) {
      try {
        const res = await this.client.futuresInstrument(inst.symbol);
        const d = res?.instrument || res;
        Object.assign(inst, {
          tick: num(d.price_increment) || inst.tick,
          qtyStep: num(d.quantity_increment) || inst.qtyStep,
          minQty: num(d.min_quantity) || num(d.min_trade_size) || inst.minQty,
          minNotional: num(d.min_notional) || inst.minNotional,
          maxLeverage: num(d.max_leverage_long) || num(d.max_leverage) || null,
          active: d.status ? d.status === 'active' : true,
          rules: 'exchange',
        });
      } catch (e) {
        log('warn', `${inst.symbol}: could not load futures contract rules (${e.message}) — using estimated tick/step sizes`);
      }
    }
    this.loadedRules = true;
  }
}
