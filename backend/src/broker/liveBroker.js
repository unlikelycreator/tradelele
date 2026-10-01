import crypto from 'node:crypto';
import { log } from '../lib/bus.js';
import { floorQty, roundPrice } from '../data/instruments.js';
import { sleep, waitForFinal } from './orders.js';

/** Unique client order id (traceable in your CoinDCX order history). */
export function makeClientId(prefix = 'zt') {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

/** CoinDCX order status → OPEN | FILLED | CANCELLED | REJECTED */
export function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'filled') return 'FILLED';
  if (v === 'rejected') return 'REJECTED';
  if (v === 'cancelled' || v === 'partially_cancelled') return 'CANCELLED';
  return 'OPEN'; // init, initial, open, partially_filled, untriggered
}

function orderView(o) {
  if (!o) return { status: 'OPEN', filledQty: 0, avgPrice: null };
  const total = +(o.total_quantity ?? 0);
  const remaining = +(o.remaining_quantity ?? 0);
  const cancelled = +(o.cancelled_quantity ?? 0);
  const status = mapStatus(o.status);
  const filledQty = status === 'FILLED' ? total - cancelled : Math.max(0, total - remaining - cancelled);
  return { status, filledQty: +filledQty.toPrecision(12), avgPrice: +(o.avg_price ?? 0) || null, remark: o.display_message || o.message || undefined, raw: o.status };
}

const sideOf = (s) => (s === 'BUY' ? 'buy' : 'sell');
const posQty = (p) => +(p?.active_pos ?? 0);

/**
 * Real orders on CoinDCX. Same interface as PaperBroker.
 *
 * Protective stops (so a position stays protected if this bot crashes or loses internet):
 *  - futures: an exchange stop-market attached to the position (positions/create_tpsl)
 *  - spot:    a stop_limit sell order, where the market supports it; otherwise the bot
 *             watches the stop itself ("soft stop") and the dashboard warns you
 */
export class LiveBroker {
  constructor({ client, onOrder = () => {} }) {
    this.client = client;
    this.onOrder = onOrder;
    this.kind = 'live';
    this.leverageSet = new Map(); // pair → leverage already applied
  }

  get stopsSurviveRestart() {
    return true;
  }

  /** Futures: make sure the pair uses our leverage before the first order. */
  async prepare(inst, settings) {
    if (inst.kind !== 'futures') return;
    const lev = settings.futures.leverage;
    if (this.leverageSet.get(inst.symbol) === lev) return;
    try {
      await this.client.futuresUpdateLeverage(inst.symbol, lev);
    } catch (e) {
      log('warn', `${inst.label}: could not set leverage to ${lev}× (${e.message}) — the order carries leverage=${lev} anyway`);
    }
    this.leverageSet.set(inst.symbol, lev);
  }

  #record(inst, o, extra) {
    this.onOrder({ orderId: String(o.id), instId: inst.id, symbol: inst.symbol, status: mapStatus(o.status), createdAt: new Date(), ...extra });
  }

  async placeOrder({ inst, side, qty, orderType, price, leverage }) {
    const clientOrderId = makeClientId();
    const type = orderType === 'MARKET' ? 'market_order' : 'limit_order';
    const o =
      inst.kind === 'futures'
        ? await this.client.futuresCreateOrder({ pair: inst.symbol, side: sideOf(side), orderType: type, qty, price: orderType === 'LIMIT' ? price : undefined, leverage, clientOrderId })
        : await this.client.spotCreateOrder({ market: inst.symbol, side: sideOf(side), orderType: type, qty, price: orderType === 'LIMIT' ? price : undefined, clientOrderId });
    this.#record(inst, o, { side, qty, orderType, price, clientOrderId });
    return { orderId: String(o.id), status: mapStatus(o.status) };
  }

  async getOrder(orderId, inst) {
    if (inst.kind === 'spot') return orderView(await this.client.spotOrderStatus(orderId));
    const orders = await this.client.futuresOrders();
    const o = orders.find((x) => String(x.id) === String(orderId));
    if (o) return orderView(o);
    return { status: 'OPEN', filledQty: 0, avgPrice: null, remark: 'order not listed yet' };
  }

  async cancelOrder(orderId, inst) {
    if (inst.kind === 'spot') await this.client.spotCancelOrder(orderId);
    else await this.client.futuresCancelOrder(orderId);
  }

  /** Spot buy fees may be taken in the coin: never try to sell more than the wallet holds. */
  async sellableQty(inst, qty) {
    if (inst.kind !== 'spot') return qty;
    try {
      const balances = await this.client.spotBalances();
      const b = balances.find((x) => x.currency === inst.base);
      const free = +(b?.balance ?? 0);
      return free > 0 ? Math.min(qty, floorQty(inst, free + +(b?.locked_balance ?? 0))) : qty;
    } catch {
      return qty;
    }
  }

  // ── futures position helpers ──

  async #position(inst) {
    const list = await this.client.futuresPositions();
    return list.find((p) => p.pair === inst.symbol && posQty(p) !== 0) || null;
  }

  /** Average price of the most recent filled order on this pair/side (exit or stop fill). */
  async #lastFill(inst, side, sinceMs) {
    try {
      const orders = await this.client.futuresOrders({ statuses: 'filled,partially_cancelled' });
      const fills = orders
        .filter((o) => o.pair === inst.symbol && String(o.side).toLowerCase() === sideOf(side) && +(o.avg_price ?? 0) > 0)
        .filter((o) => !sinceMs || +new Date(o.updated_at ?? o.created_at) >= sinceMs - 60_000)
        .sort((a, b) => +new Date(b.updated_at ?? b.created_at) - +new Date(a.updated_at ?? a.created_at));
      return fills[0] ? +fills[0].avg_price : null;
    } catch {
      return null;
    }
  }

  // ── protective stop ──

  async placeStop(trade, inst, stopPrice) {
    if (inst.kind === 'futures') {
      let pos = null;
      for (let i = 0; i < 6 && !pos; i++) {
        pos = await this.#position(inst);
        if (!pos) await sleep(800);
      }
      if (!pos) throw new Error('position not visible yet on CoinDCX');
      await this.client.futuresSetStopLoss(pos.id, stopPrice);
      return { stopId: `pos:${pos.id}`, positionId: String(pos.id), type: 'STOP_MARKET' };
    }
    if (!inst.stopLimit) throw new Error(`CoinDCX does not offer stop-limit orders on ${inst.symbol}`);
    // stop-limit sell: limit 0.5% below the trigger so it still fills in a fast fall
    const limit = roundPrice(inst, stopPrice * 0.995, 'down');
    const o = await this.client.spotCreateOrder({ market: inst.symbol, side: 'sell', orderType: 'stop_limit', qty: trade.qty, price: limit, stopPrice, clientOrderId: makeClientId('zts') });
    this.#record(inst, o, { side: 'SELL', qty: trade.qty, orderType: 'STOP_LIMIT', price: limit, triggerPrice: stopPrice });
    return { stopId: String(o.id), type: 'STOP_LIMIT' };
  }

  async moveStop(trade, inst, stopPrice) {
    if (inst.kind === 'futures') {
      const st = await this.stopStatus(trade, inst);
      if (st.status === 'FILLED') return { filled: true, avgPrice: st.avgPrice };
      await this.client.futuresSetStopLoss(trade.positionId, stopPrice);
      return { stopId: trade.stopId, positionId: trade.positionId, type: 'STOP_MARKET' };
    }
    // spot: cancel and re-place (CoinDCX can only edit the limit price of an order)
    const st = await this.cancelStop(trade, inst);
    if (st.status === 'FILLED') return { filled: true, avgPrice: st.avgPrice };
    return this.placeStop(trade, inst, stopPrice);
  }

  async stopStatus(trade, inst) {
    if (inst.kind === 'spot') return this.getOrder(trade.stopId, inst);
    const pos = await this.#position(inst);
    if (!pos) {
      const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
      return { status: 'FILLED', avgPrice: await this.#lastFill(inst, exitSide, trade.entryAt && +new Date(trade.entryAt)) };
    }
    trade.positionId = String(pos.id);
    if (pos.stop_loss_trigger == null || +pos.stop_loss_trigger === 0) return { status: 'CANCELLED', remark: 'no stop-loss on the position' };
    return { status: 'OPEN' };
  }

  /**
   * Make sure the stop can no longer fire before we exit ourselves.
   * Futures: the stop is attached to the position and dies with it when we exit the whole
   * position, so we only need to know whether it already fired.
   */
  async cancelStop(trade, inst) {
    if (inst.kind === 'futures') {
      const st = await this.stopStatus(trade, inst);
      return st.status === 'FILLED' ? st : { status: 'CANCELLED' };
    }
    try {
      await this.client.spotCancelOrder(trade.stopId);
    } catch {
      /* may have just executed — checked below */
    }
    return waitForFinal(this, trade.stopId, inst, 8000);
  }

  async exitPosition(trade, inst, qty) {
    const exitSide = trade.side === 'BUY' ? 'SELL' : 'BUY';
    if (inst.kind === 'futures') {
      const started = Date.now();
      const pos = await this.#position(inst);
      if (pos) {
        await this.client.futuresExitPosition(pos.id);
        let open = pos;
        for (let i = 0; i < 15 && open; i++) {
          await sleep(800);
          open = await this.#position(inst);
        }
        if (open) throw new Error(`position still open on CoinDCX (${posQty(open)})`);
      }
      return { filledQty: qty, avgPrice: await this.#lastFill(inst, exitSide, started) };
    }
    const sellQty = await this.sellableQty(inst, qty);
    const r = await this.placeOrder({ inst, side: exitSide, qty: sellQty, orderType: 'MARKET' });
    const st = await waitForFinal(this, r.orderId, inst, 15_000);
    if (!(st.filledQty > 0)) throw new Error(`exit order ${st.status}${st.remark ? `: ${st.remark}` : ''}`);
    // a partial fill is returned as such; the engine re-sends the rest (or ignores fee dust)
    return { filledQty: st.filledQty, avgPrice: st.avgPrice, orderId: r.orderId };
  }

  onTick() {}
}
