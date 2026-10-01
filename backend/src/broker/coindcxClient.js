import crypto from 'node:crypto';
import { config } from '../config.js';
import { createCoinDcxLimiters } from '../lib/rateLimiter.js';

export class CoinDcxError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'CoinDcxError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/** HMAC-SHA256 hex of the exact JSON body string, keyed with the API secret. */
export function signBody(bodyString, secret) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
}

/**
 * Thin CoinDCX REST client (spot + USDT-margined futures).
 *
 * Auth: private endpoints are POSTs whose JSON body carries `timestamp` (ms). The body string
 * is signed with HMAC-SHA256(secret) and sent with headers X-AUTH-APIKEY / X-AUTH-SIGNATURE.
 * Public market data needs no keys, so paper trading works without any credentials.
 *
 * Responses are parsed defensively (object-or-array, several field-name variants) because
 * CoinDCX's payloads differ slightly between endpoints and over time.
 */
export class CoinDcxClient {
  constructor({ apiKey = config.coindcx.apiKey, apiSecret = config.coindcx.apiSecret, apiUrl = config.coindcx.apiUrl, publicUrl = config.coindcx.publicUrl } = {}) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiUrl = apiUrl;
    this.publicUrl = publicUrl;
    this.limiters = createCoinDcxLimiters();
  }

  get hasKeys() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  usage() {
    return Object.values(this.limiters).map((l) => l.usage());
  }

  // ── transport ────────────────────────────────────────────

  async #fetch(url, init, group, { retries = 0 } = {}) {
    const limiter = this.limiters[group];
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      let res;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
      } catch (e) {
        if (attempt < retries) continue;
        throw new CoinDcxError(`network error: ${e.message}`, { path: url });
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (res.status === 429) limiter.pause(5000);
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) continue;
        const msg = json?.message || json?.error || json?.errors?.[0] || text?.slice(0, 200) || `HTTP ${res.status}`;
        throw new CoinDcxError(`${res.status} ${msg}`, { status: res.status, body: json, path: new URL(url).pathname });
      }
      return json;
    }
  }

  /** Public GET. Safe to retry. */
  get(path, query = {}, { base = this.apiUrl, group = 'marketData' } = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString();
    return this.#fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { method: 'GET' }, group, { retries: 1 });
  }

  /** Signed POST. Never retried automatically (an order must not be sent twice). */
  post(path, body = {}, { group = 'account' } = {}) {
    if (!this.hasKeys) throw new CoinDcxError('COINDCX_API_KEY / COINDCX_API_SECRET are not set');
    const payload = JSON.stringify({ ...body, timestamp: Date.now() });
    return this.#fetch(
      `${this.apiUrl}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': this.apiKey, 'X-AUTH-SIGNATURE': signBody(payload, this.apiSecret) },
        body: payload,
      },
      group,
    );
  }

  // ── public market data ───────────────────────────────────

  /** All spot tickers: [{ market: 'BTCUSDT', last_price, bid, ask, change_24_hour, ... }] */
  spotTickers() {
    return this.get('/exchange/ticker');
  }

  /** Spot market rules: precision, min qty/notional, supported order types, candle pair code. */
  spotMarketsDetails() {
    return this.get('/exchange/v1/markets_details');
  }

  /** Spot candles, newest first: [{ open, high, low, close, volume, time }] */
  spotCandles(pair, interval, limit = 300) {
    return this.get('/market_data/candles', { pair, interval, limit }, { base: this.publicUrl });
  }

  /** Real-time futures prices for every pair: { prices: { 'B-BTC_USDT': { ls: last, mp: mark, ... } } } */
  futuresPrices() {
    return this.get('/market_data/v3/current_prices/futures/rt', {}, { base: this.publicUrl });
  }

  /** Futures candles: { s: 'ok', data: [{ open, high, low, close, volume, time }] } */
  futuresCandles(pair, resolution, fromSec, toSec) {
    return this.get('/market_data/candlesticks', { pair, from: fromSec, to: toSec, resolution, pcode: 'f' }, { base: this.publicUrl });
  }

  /** Futures contract rules: { instrument: { quantity_increment, price_increment, min_quantity, min_notional, max_leverage_long, ... } } */
  futuresInstrument(pair) {
    return this.get('/exchange/v1/derivatives/futures/data/instrument', { pair, margin_currency_short_name: 'USDT' });
  }

  // ── spot (private) ───────────────────────────────────────

  spotBalances() {
    return this.post('/exchange/v1/users/balances', {});
  }

  /** order_type: market_order | limit_order | stop_limit. Returns the created order. */
  async spotCreateOrder({ market, side, orderType, qty, price, stopPrice, clientOrderId }) {
    const body = { market, side, order_type: orderType, total_quantity: qty, client_order_id: clientOrderId };
    if (price != null) body.price_per_unit = price;
    if (stopPrice != null) body.stop_price = stopPrice;
    const res = await this.post('/exchange/v1/orders/create', body, { group: 'orders' });
    const order = firstOrder(res);
    if (!order?.id) throw new CoinDcxError(`order not accepted: ${JSON.stringify(res)?.slice(0, 200)}`);
    return order;
  }

  async spotOrderStatus(id) {
    return firstOrder(await this.post('/exchange/v1/orders/status', { id }));
  }

  spotCancelOrder(id) {
    return this.post('/exchange/v1/orders/cancel', { id }, { group: 'orders' });
  }

  // ── futures (private) ────────────────────────────────────

  /** order_type: market_order | limit_order. Returns the created order. */
  async futuresCreateOrder({ pair, side, orderType, qty, price, leverage, clientOrderId }) {
    const order = {
      side,
      pair,
      order_type: orderType,
      total_quantity: qty,
      leverage,
      notification: 'no_notification',
      time_in_force: orderType === 'market_order' ? undefined : 'good_till_cancel',
      hidden: false,
      post_only: false,
      margin_currency_short_name: 'USDT',
      client_order_id: clientOrderId,
    };
    if (price != null) order.price = price;
    const res = await this.post('/exchange/v1/derivatives/futures/orders/create', { order: JSON.parse(JSON.stringify(order)) }, { group: 'orders' });
    const created = firstOrder(res);
    if (!created?.id) throw new CoinDcxError(`order not accepted: ${JSON.stringify(res)?.slice(0, 200)}`);
    return created;
  }

  /** Recent futures orders across statuses (CoinDCX has no single-order lookup we can rely on). */
  async futuresOrders({ statuses = 'open,partially_filled,filled,cancelled,rejected,untriggered,initial,partially_cancelled', size = 50 } = {}) {
    const res = await this.post('/exchange/v1/derivatives/futures/orders', { status: statuses, page: '1', size: String(size), margin_currency_short_name: ['USDT'] });
    return Array.isArray(res) ? res : res?.orders || res?.data || [];
  }

  futuresCancelOrder(id) {
    return this.post('/exchange/v1/derivatives/futures/orders/cancel', { id }, { group: 'orders' });
  }

  async futuresPositions() {
    const res = await this.post('/exchange/v1/derivatives/futures/positions', { page: '1', size: '50', margin_currency_short_name: ['USDT'] });
    return Array.isArray(res) ? res : res?.positions || res?.data || [];
  }

  /** Close the whole position at market. */
  futuresExitPosition(positionId) {
    return this.post('/exchange/v1/derivatives/futures/positions/exit', { id: positionId }, { group: 'orders' });
  }

  /** Attach / replace the exchange stop-loss (stop-market) on an open position. */
  futuresSetStopLoss(positionId, stopPrice) {
    return this.post(
      '/exchange/v1/derivatives/futures/positions/create_tpsl',
      { id: positionId, stop_loss: { stop_price: String(stopPrice), order_type: 'stop_market' } },
      { group: 'orders' },
    );
  }

  futuresUpdateLeverage(pair, leverage) {
    return this.post('/exchange/v1/derivatives/futures/positions/update_leverage', { pair, leverage: String(leverage) });
  }
}

/** CoinDCX returns an order as `{...}`, `[{...}]` or `{ orders: [{...}] }` depending on the endpoint. */
export function firstOrder(res) {
  if (Array.isArray(res)) return res[0];
  if (Array.isArray(res?.orders)) return res.orders[0];
  if (Array.isArray(res?.data)) return res.data[0];
  return res;
}
