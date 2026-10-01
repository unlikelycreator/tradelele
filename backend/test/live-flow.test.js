/**
 * End-to-end test of the LIVE order path against a mock CoinDCX API server:
 *  futures: set leverage → market entry → stop-loss attached to the position (create_tpsl)
 *           → breakeven move (create_tpsl again) → target → exit position
 *  spot:    market buy → stop_limit sell → breakeven (cancel + re-place) → target
 *           (cancel the stop FIRST, then market sell — never a double sell)
 * Every private request's HMAC signature is verified. Uses the in-memory DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { barStart } from '../src/lib/time.js';

process.env.MONGO_URI = 'memory';

const KEY = 'test-key';
const SECRET = 'test-secret';

function mockCoinDcx() {
  const { signBody } = globalThis.__sign;
  const price = new Map([['B-BTC_USDT', 61000], ['ETHUSDT', 2545]]);
  const calls = [];
  const futOrders = [];
  const spotOrders = new Map();
  const positions = new Map(); // pair → position
  let seq = 0;
  const now = () => new Date().toISOString();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const send = (obj, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET') {
        if (p === '/exchange/v1/markets_details') {
          return send([{ coindcx_name: 'ETHUSDT', pair: 'B-ETH_USDT', base_currency_precision: 2, target_currency_precision: 4, min_quantity: 0.0001, min_notional: 5, order_types: ['market_order', 'limit_order', 'stop_limit'], status: 'active' }]);
        }
        if (p === '/exchange/v1/derivatives/futures/data/instrument') {
          return send({ instrument: { pair: url.searchParams.get('pair'), quantity_increment: '0.001', price_increment: '0.1', min_quantity: '0.001', min_notional: '5', max_leverage_long: '20', status: 'active' } });
        }
        return send({ message: 'not found' }, 404);
      }
      // private: verify the signature over the exact body string
      if (req.headers['x-auth-apikey'] !== KEY || req.headers['x-auth-signature'] !== signBody(body, SECRET)) return send({ message: 'Invalid signature' }, 401);
      const json = JSON.parse(body);
      assert.ok(json.timestamp > 1e12, 'timestamp in ms');
      calls.push({ path: p, body: json });

      if (p === '/exchange/v1/derivatives/futures/positions/update_leverage') return send({ message: 'ok' });
      if (p === '/exchange/v1/derivatives/futures/orders/create') {
        const o = json.order;
        const px = price.get(o.pair);
        const order = { id: `F${++seq}`, pair: o.pair, side: o.side, order_type: o.order_type, status: 'filled', total_quantity: o.total_quantity, remaining_quantity: 0, avg_price: px, leverage: o.leverage, created_at: now(), updated_at: now() };
        futOrders.push(order);
        const signed = o.side === 'buy' ? o.total_quantity : -o.total_quantity;
        positions.set(o.pair, { id: `pos-${o.pair}`, pair: o.pair, active_pos: signed, avg_price: px, stop_loss_trigger: null });
        return send([order]);
      }
      if (p === '/exchange/v1/derivatives/futures/orders') return send(futOrders);
      if (p === '/exchange/v1/derivatives/futures/positions') return send([...positions.values()]);
      if (p === '/exchange/v1/derivatives/futures/positions/create_tpsl') {
        const pos = [...positions.values()].find((x) => x.id === json.id);
        if (!pos) return send({ message: 'position not found' }, 400);
        pos.stop_loss_trigger = +json.stop_loss.stop_price;
        return send({ stop_loss: { status: 'untriggered' } });
      }
      if (p === '/exchange/v1/derivatives/futures/positions/exit') {
        const pos = [...positions.values()].find((x) => x.id === json.id);
        const side = pos.active_pos > 0 ? 'sell' : 'buy';
        futOrders.push({ id: `F${++seq}`, pair: pos.pair, side, order_type: 'market_order', status: 'filled', total_quantity: Math.abs(pos.active_pos), remaining_quantity: 0, avg_price: price.get(pos.pair), created_at: now(), updated_at: now() });
        pos.active_pos = 0;
        pos.stop_loss_trigger = null;
        return send({ message: 'success' });
      }
      if (p === '/exchange/v1/orders/create') {
        const filled = json.order_type === 'market_order';
        const o = { id: `S${++seq}`, market: json.market, side: json.side, order_type: json.order_type, status: filled ? 'filled' : 'untriggered', total_quantity: json.total_quantity, remaining_quantity: filled ? 0 : json.total_quantity, avg_price: filled ? price.get(json.market) : 0, price_per_unit: json.price_per_unit, stop_price: json.stop_price };
        spotOrders.set(o.id, o);
        return send({ orders: [o] });
      }
      if (p === '/exchange/v1/orders/status') return send(spotOrders.get(json.id) || { message: 'not found' }, spotOrders.has(json.id) ? 200 : 404);
      if (p === '/exchange/v1/orders/cancel') {
        const o = spotOrders.get(json.id);
        if (o.status === 'untriggered' || o.status === 'open') o.status = 'cancelled';
        return send({ message: 'cancelled' });
      }
      if (p === '/exchange/v1/users/balances') {
        const bought = [...spotOrders.values()].filter((o) => o.status === 'filled').reduce((s, o) => s + (o.side === 'buy' ? 1 : -1) * o.total_quantity, 0);
        return send([{ currency: 'ETH', balance: Math.max(0, bought), locked_balance: 0 }, { currency: 'USDT', balance: 900, locked_balance: 0 }]);
      }
      return send({ message: `unknown ${p}` }, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, calls, futOrders, spotOrders, positions, price, port: server.address().port })));
}

/** Rising candles (trend up) whose last CLOSED candle breaks out above the channel. */
function makeCandles(base, step, half, lastClose, tf = 15) {
  const tfMs = tf * 60_000;
  const lastClosedStart = barStart(Date.now(), tf) - tfMs;
  const out = [];
  for (let i = 0; i < 60; i++) {
    const mid = base + i * step;
    out.push({ time: lastClosedStart - (60 - i) * tfMs, open: mid, high: mid + half, low: mid - half, close: mid, volume: 1 });
  }
  out.push({ time: lastClosedStart, open: base + 60 * step, high: lastClose + 1, low: base + 60 * step - 1, close: lastClose, volume: 1 });
  out.push({ time: lastClosedStart + tfMs, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 1, forming: true });
  return out;
}

async function until(fn, ms = 15_000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('live order lifecycle against mock CoinDCX (futures + spot)', { timeout: 60_000 }, async () => {
  globalThis.__sign = await import('../src/broker/coindcxClient.js');
  const mock = await mockCoinDcx();
  const base = `http://127.0.0.1:${mock.port}`;
  const { connectDb, col } = await import('../src/db.js');
  await connectDb();
  const { CoinDcxClient } = globalThis.__sign;
  const { LiveBroker } = await import('../src/broker/liveBroker.js');
  const { MarketData } = await import('../src/data/marketData.js');
  const { InstrumentRegistry } = await import('../src/data/instruments.js');
  const { RealClock } = await import('../src/lib/clock.js');
  const { Engine } = await import('../src/engine/engine.js');
  const { DEFAULT_SETTINGS } = await import('../src/config.js');

  const client = new CoinDcxClient({ apiKey: KEY, apiSecret: SECRET, apiUrl: base, publicUrl: base });
  const clock = new RealClock();
  const md = new MarketData(clock);
  const candles = { 'F:B-BTC_USDT': makeCandles(60000, 10, 150, 61000), 'S:ETHUSDT': makeCandles(2500, 0.5, 6, 2545) };
  const feed = { setInstruments() {}, start() {}, stop() {}, status: () => ({ source: 'mock' }), candles: async (inst) => candles[inst.id] };
  const settings = { ...DEFAULT_SETTINGS, market: 'both', spotSymbols: ['ETHUSDT'], futuresPairs: ['B-BTC_USDT'], capital: 1000 };
  const engine = new Engine({ clock, marketData: md, feed, broker: new LiveBroker({ client }), instruments: new InstrumentRegistry({ client }), mode: 'live', requestedMode: 'live', settings, capitalDefault: 1000, client });

  md.pushTick('F:B-BTC_USDT', 61000);
  md.pushTick('S:ETHUSDT', 2545);
  await engine.start();
  try {
    // ── entries ──
    const open = await until(() => {
      const p = engine.snapshot().positions.filter((x) => x.status === 'OPEN' && x.stop);
      return p.length === 2 && p;
    }, 15_000, 'two open positions');
    const fut = open.find((p) => p.kind === 'futures');
    const spot = open.find((p) => p.kind === 'spot');
    assert.equal(fut.side, 'BUY');
    assert.equal(fut.stopType, 'STOP_MARKET');
    assert.equal(spot.stopType, 'STOP_LIMIT');
    assert.equal(fut.leverage, 3);
    assert.ok(mock.calls.some((c) => c.path.endsWith('/update_leverage') && c.body.leverage === '3'), 'leverage set before entry');
    const entryOrder = mock.calls.find((c) => c.path.endsWith('/futures/orders/create')).body.order;
    assert.equal(entryOrder.order_type, 'market_order');
    assert.equal(entryOrder.leverage, 3);
    assert.equal(mock.positions.get('B-BTC_USDT').stop_loss_trigger, fut.stop, 'exchange stop attached to the position');
    const spotStop = [...mock.spotOrders.values()].find((o) => o.order_type === 'stop_limit');
    assert.equal(spotStop.stop_price, spot.stop);
    assert.ok(spotStop.price_per_unit < spot.stop, 'stop-limit price sits below the trigger');

    // ── +1R → breakeven ──
    const futRisk = fut.entryPrice - fut.stop;
    const spotRisk = spot.entryPrice - spot.stop;
    md.pushTick('F:B-BTC_USDT', fut.entryPrice + futRisk * 1.1);
    md.pushTick('S:ETHUSDT', spot.entryPrice + spotRisk * 1.1);
    await until(() => engine.snapshot().positions.every((p) => p.trailed), 10_000, 'breakeven moves');
    const be = engine.snapshot().positions;
    assert.ok(be.find((p) => p.kind === 'futures').stop > fut.entryPrice, 'futures stop above entry (covers fees)');
    assert.equal(mock.positions.get('B-BTC_USDT').stop_loss_trigger, be.find((p) => p.kind === 'futures').stop);
    assert.equal(spotStop.status, 'cancelled', 'old spot stop cancelled');
    const spotStops = [...mock.spotOrders.values()].filter((o) => o.order_type === 'stop_limit' && o.status === 'untriggered');
    assert.equal(spotStops.length, 1, 'exactly one live spot stop');

    // ── target ──
    mock.price.set('B-BTC_USDT', fut.target + 50);
    mock.price.set('ETHUSDT', spot.target + 1);
    md.pushTick('F:B-BTC_USDT', fut.target + 50);
    md.pushTick('S:ETHUSDT', spot.target + 1);
    await until(() => engine.snapshot().positions.length === 0, 15_000, 'exits');

    const trades = await col('trades').find({ mode: 'live', status: 'CLOSED' }).toArray();
    assert.equal(trades.length, 2);
    for (const t of trades) {
      assert.equal(t.exitReason, 'target');
      assert.ok(t.netPnl > 0, `${t.label} net ${t.netPnl}`);
      assert.ok(t.fees > 0);
    }
    assert.ok(trades.find((t) => t.kind === 'spot').tds > 0, 'TDS recorded on the spot sell');
    assert.equal(mock.positions.get('B-BTC_USDT').active_pos, 0, 'futures position closed');
    // spot: the stop was cancelled BEFORE the market sell
    const spotCalls = mock.calls.filter((c) => c.path === '/exchange/v1/orders/cancel' || (c.path === '/exchange/v1/orders/create' && c.body.order_type === 'market_order' && c.body.side === 'sell'));
    assert.deepEqual(spotCalls.slice(-2).map((c) => c.path), ['/exchange/v1/orders/cancel', '/exchange/v1/orders/create']);
    assert.equal([...mock.spotOrders.values()].filter((o) => o.order_type === 'stop_limit' && o.status === 'untriggered').length, 0, 'no stop left working');
    assert.equal(engine.snapshot().day.closed, 2);
  } finally {
    engine.stop();
    mock.server.close();
  }
});
