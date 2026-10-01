import crypto from 'node:crypto';
import { waitForFinal } from './orders.js';

/**
 * Simulated broker for paper trading. Uses real CoinDCX prices from the market-data feed:
 *  - MARKET orders fill at the current price ± slippage
 *  - LIMIT orders fill when marketable (never worse than the limit price)
 *  - STOP_MARKET orders fill at market (± slippage) once the price crosses the trigger,
 *    so a fast move fills you worse than your stop — as it would on the exchange
 * Order states: OPEN | FILLED | REJECTED | CANCELLED
 */
export class PaperBroker {
  constructor({ marketData, slippageBps = 5, onOrder = () => {} }) {
    this.md = marketData;
    this.slippageBps = slippageBps;
    this.orders = new Map();
    this.onOrder = onOrder;
    this.kind = 'paper';
  }

  #slip(price, side) {
    const s = (price * this.slippageBps) / 10_000;
    return +(side === 'BUY' ? price + s : price - s).toPrecision(10);
  }

  #fill(o, price) {
    Object.assign(o, { status: 'FILLED', filledQty: o.qty, avgPrice: price, filledAt: new Date() });
    this.onOrder(o);
  }

  #match(o, ltp) {
    if (!(ltp > 0)) return;
    if (o.orderType === 'MARKET' || (o.orderType === 'STOP_MARKET' && o.triggered)) return this.#fill(o, this.#slip(ltp, o.side));
    if (o.orderType === 'LIMIT') {
      const px = this.#slip(ltp, o.side);
      if (o.side === 'BUY' && o.price >= ltp) this.#fill(o, Math.min(px, o.price));
      else if (o.side === 'SELL' && o.price <= ltp) this.#fill(o, Math.max(px, o.price));
    }
  }

  async prepare() {}

  async placeOrder({ inst, side, qty, orderType, price, triggerPrice }) {
    const order = {
      orderId: `PAPER-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      instId: inst.id,
      symbol: inst.symbol,
      side,
      qty,
      orderType,
      price,
      triggerPrice,
      status: 'OPEN',
      filledQty: 0,
      avgPrice: null,
      createdAt: new Date(),
    };
    this.orders.set(order.orderId, order);
    const ltp = this.md.ltp(inst.id);
    if (orderType === 'MARKET' && !ltp) Object.assign(order, { status: 'REJECTED', remark: 'No price available' });
    else if (orderType !== 'STOP_MARKET') this.#match(order, ltp);
    this.onOrder(order);
    return { orderId: order.orderId, status: order.status };
  }

  async getOrder(orderId) {
    const o = this.orders.get(orderId);
    if (!o) return { status: 'REJECTED', remark: 'Unknown order', filledQty: 0 };
    return { status: o.status, filledQty: o.filledQty, avgPrice: o.avgPrice, remark: o.remark };
  }

  async cancelOrder(orderId) {
    const o = this.orders.get(orderId);
    if (o && o.status === 'OPEN') {
      o.status = 'CANCELLED';
      this.onOrder(o);
    }
  }

  // ── protective stop ──

  async placeStop(trade, inst, stopPrice) {
    const side = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const r = await this.placeOrder({ inst, side, qty: trade.qty, orderType: 'STOP_MARKET', triggerPrice: stopPrice });
    return { stopId: r.orderId, type: 'STOP_MARKET' };
  }

  async moveStop(trade, inst, stopPrice) {
    const o = this.orders.get(trade.stopId);
    if (!o || o.status !== 'OPEN') {
      const st = await this.getOrder(trade.stopId);
      if (st.status === 'FILLED') return { filled: true, avgPrice: st.avgPrice };
      return this.placeStop(trade, inst, stopPrice);
    }
    o.triggerPrice = stopPrice;
    this.onOrder(o);
    return { stopId: o.orderId, type: 'STOP_MARKET' };
  }

  stopStatus(trade) {
    return this.getOrder(trade.stopId);
  }

  async cancelStop(trade) {
    await this.cancelOrder(trade.stopId);
    return this.getOrder(trade.stopId);
  }

  async exitPosition(trade, inst, qty) {
    const side = trade.side === 'BUY' ? 'SELL' : 'BUY';
    const r = await this.placeOrder({ inst, side, qty, orderType: 'MARKET' });
    const st = await waitForFinal(this, r.orderId, inst, 2000);
    if (st.status !== 'FILLED') throw new Error(`exit order ${st.status}${st.remark ? `: ${st.remark}` : ''}`);
    return { filledQty: st.filledQty, avgPrice: st.avgPrice, orderId: r.orderId };
  }

  /** Called on every price update: trigger stops, fill resting limits. */
  onTick(id, ltp) {
    for (const o of this.orders.values()) {
      if (o.status !== 'OPEN' || o.instId !== id) continue;
      if (o.orderType === 'STOP_MARKET' && !o.triggered) {
        o.triggered = o.side === 'SELL' ? ltp <= o.triggerPrice : ltp >= o.triggerPrice;
        if (!o.triggered) continue;
      }
      this.#match(o, ltp);
    }
  }

  /** Paper stops live in memory: after a restart the engine re-creates them. */
  get stopsSurviveRestart() {
    return false;
  }
}
