import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/lib/rateLimiter.js';
import { roundTripFees, spotTds, roundTripCostPct } from '../src/lib/fees.js';
import { barStart, istDate } from '../src/lib/time.js';
import { atr, breakoutSignal, ema, indicators, pnl, stopAndTarget, trailStop } from '../src/strategy/breakout.js';
import { entryBlockReason, liquidationBlock, positionSize } from '../src/engine/risk.js';
import { PaperBroker } from '../src/broker/paperBroker.js';
import { mapStatus } from '../src/broker/liveBroker.js';
import { firstOrder, signBody } from '../src/broker/coindcxClient.js';
import { aggregate, normCandle } from '../src/data/marketData.js';
import { baseOf, defaultSpecs, floorQty, instId, labelOf, parseInstId, roundPrice } from '../src/data/instruments.js';
import { validateSettings } from '../src/engine/settings.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

const S = DEFAULT_SETTINGS;
const BTC = { id: 'F:B-BTC_USDT', kind: 'futures', symbol: 'B-BTC_USDT', label: 'BTC-PERP', tick: 0.1, qtyStep: 0.001, minQty: 0.001, minNotional: 5 };
const ETH_SPOT = { id: 'S:ETHUSDT', kind: 'spot', symbol: 'ETHUSDT', label: 'ETH/USDT', tick: 0.01, qtyStep: 0.0001, minQty: 0.0001, minNotional: 5 };

/** Flat candles around `price` with a fixed range, then a final candle closing at `lastClose`. */
function candles(n, price, lastClose, range = 10) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: i * 900_000, open: price, high: price + range / 2, low: price - range / 2, close: price });
  out.push({ time: n * 900_000, open: price, high: Math.max(price, lastClose) + 1, low: Math.min(price, lastClose) - 1, close: lastClose });
  return out;
}

test('IST date and candle boundaries', () => {
  assert.equal(istDate(new Date('2026-09-30T19:00:00Z')), '2026-10-01'); // 00:30 IST next day
  assert.equal(barStart(Date.UTC(2026, 0, 1, 10, 7, 30), 15), Date.UTC(2026, 0, 1, 10, 0));
  assert.equal(barStart(Date.UTC(2026, 0, 1, 10, 59), 60), Date.UTC(2026, 0, 1, 10, 0));
});

test('CoinDCX signature is HMAC-SHA256 hex of the exact body', () => {
  const body = JSON.stringify({ market: 'BTCUSDT', timestamp: 1700000000000 });
  // reference value computed independently with: printf '%s' "$body" | openssl dgst -sha256 -hmac secret
  assert.equal(signBody(body, 'secret'), '3324559e5c71a6c763f663c0b5b40505a77dae7a868cf3dd5a41dbdd6a9864ed');
  assert.notEqual(signBody(body, 'secret'), signBody(body, 'other'));
});

test('order/response helpers', () => {
  assert.equal(firstOrder({ orders: [{ id: 'a' }] }).id, 'a');
  assert.equal(firstOrder([{ id: 'b' }]).id, 'b');
  assert.equal(firstOrder({ id: 'c' }).id, 'c');
  assert.equal(mapStatus('filled'), 'FILLED');
  assert.equal(mapStatus('partially_cancelled'), 'CANCELLED');
  assert.equal(mapStatus('untriggered'), 'OPEN');
  assert.equal(mapStatus('rejected'), 'REJECTED');
});

test('instrument ids, labels and rounding', () => {
  assert.equal(instId('futures', 'B-BTC_USDT'), 'F:B-BTC_USDT');
  assert.deepEqual(parseInstId('S:ETHUSDT'), { kind: 'spot', symbol: 'ETHUSDT' });
  assert.equal(baseOf('futures', 'B-SOL_USDT'), 'SOL');
  assert.equal(labelOf('spot', 'XRPUSDT'), 'XRP/USDT');
  assert.equal(floorQty(BTC, 0.12399), 0.123);
  assert.equal(roundPrice(BTC, 60000.06), 60000.1);
  assert.equal(roundPrice(BTC, 60000.06, 'down'), 60000);
  assert.equal(roundPrice({ tick: 0.5 }, 100.3, 'up'), 100.5);
  assert.deepEqual(defaultSpecs(60000), { tick: 1, qtyStep: 0.0001, minQty: 0.0001, minNotional: 5 });
});

test('candle normalisation and aggregation', () => {
  assert.equal(normCandle({ time: 1700000000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '3' }).time, 1700000000000);
  const five = [];
  for (let i = 0; i < 7; i++) five.push({ time: Date.UTC(2026, 0, 1, 0, 5 * i + 5), open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 1 });
  // 00:05 bucket is partial (only 2 of 3 five-minute bars) → dropped
  const agg = aggregate(five, 15, 5);
  assert.equal(agg[0].time, Date.UTC(2026, 0, 1, 0, 15));
  assert.deepEqual([agg[0].open, agg[0].high, agg[0].low, agg[0].close, agg[0].volume], [2, 5, 1, 4.5, 3]);
});

test('EMA and ATR', () => {
  assert.equal(ema([1, 2, 3], 3), 2);
  assert.ok(Math.abs(ema([1, 2, 3, 4], 3) - 3) < 1e-9);
  const flat = candles(30, 100, 100, 2);
  assert.ok(Math.abs(atr(flat.slice(0, 30), 14) - 2) < 1e-9);
});

test('breakout signals respect buffer, trend filter, shorts and ATR band', () => {
  const s = { ...S, emaPeriod: 10, channelBars: 20, useTrendFilter: true, minAtrPct: 0.1, maxAtrPct: 5 };
  // channel high = 105; buffer 0.05% → needs close > 105.0525
  assert.equal(breakoutSignal(indicators(candles(30, 100, 105.04), s), s, { allowShort: true }), null);
  const up = breakoutSignal(indicators(candles(30, 100, 106), s), s, { allowShort: true });
  assert.equal(up.side, 'BUY');
  const down = breakoutSignal(indicators(candles(30, 100, 94), s), s, { allowShort: true });
  assert.equal(down.side, 'SELL');
  assert.equal(breakoutSignal(indicators(candles(30, 100, 94), s), s, { allowShort: false }).blocked, true);
  // trend filter: long breakout but the EMA is above the close
  const falling = candles(30, 100, 106);
  for (let i = 0; i < 25; i++) falling[i].close = 120;
  const blocked = breakoutSignal(indicators(falling, s), s, { allowShort: true });
  assert.equal(blocked?.blocked, true);
  assert.match(blocked.reason, /EMA/);
  // ATR band
  const quiet = { ...s, minAtrPct: 50 };
  assert.match(breakoutSignal(indicators(candles(30, 100, 106), quiet), quiet, { allowShort: true }).reason, /too quiet/);
  // not enough history
  assert.equal(indicators(candles(5, 100, 106), s), null);
});

test('stop = 1.5 ATR capped at maxStopPct; target = 2R', () => {
  const a = stopAndTarget({ side: 'BUY', entry: 100, atr: 1, settings: S });
  assert.equal(a.stop, 98.5);
  assert.equal(a.target, 103);
  const capped = stopAndTarget({ side: 'SELL', entry: 100, atr: 10, settings: S });
  assert.equal(capped.stop, 103); // 3% cap
  assert.equal(capped.target, 94);
  const rounded = stopAndTarget({ side: 'BUY', entry: 60000, atr: 123.45, settings: S, roundPx: (x, d) => roundPrice(BTC, x, d) });
  assert.equal(rounded.stop, 59814.8); // rounded down (further from entry) to the 0.1 tick
});

test('breakeven trail only after +1R, covers fees, only tightens', () => {
  const base = { side: 'BUY', entry: 100, stop: 98, initialRisk: 2, atr: 1, settings: { ...S, trailAtr: 0 }, costPct: 0.2 };
  assert.equal(trailStop({ ...base, price: 101 }), null);
  const be = trailStop({ ...base, price: 102 });
  assert.ok(Math.abs(be - 100.2) < 1e-9, `breakeven ${be}`);
  assert.equal(trailStop({ ...base, stop: be, price: 103 }), null); // already there
  // ATR trail on top of breakeven
  const trail = trailStop({ ...base, settings: { ...S, trailAtr: 1 }, price: 104 });
  assert.equal(trail, 103);
  // short side mirrors
  const sbe = trailStop({ ...base, side: 'SELL', stop: 102, price: 98 });
  assert.ok(Math.abs(sbe - 99.8) < 1e-9);
  assert.equal(pnl('SELL', 100, 98, 2), 4);
});

test('position sizing: risk-based, capped by margin × leverage, rounded to step', () => {
  // 100 USDT, 1% risk → 1 USDT; stop 1% away on 60k BTC → 600 per BTC → 0.00166 → 0.001
  const a = positionSize({ capital: 100, entry: 60000, stop: 59400, inst: BTC, leverage: 3, settings: S });
  assert.equal(a.qty, 0.001);
  assert.equal(a.limitedBy, 'risk');
  // tight stop → notional cap: 50% × 3× of 1000 = 1500 USDT → 0.025 BTC
  const b = positionSize({ capital: 1000, entry: 60000, stop: 59990, inst: BTC, leverage: 3, settings: S });
  assert.equal(b.qty, 0.025);
  assert.equal(b.limitedBy, 'max position');
  // spot has no leverage: 50% of 1000 = 500 USDT → 0.2 ETH at 2500
  const c = positionSize({ capital: 1000, entry: 2500, stop: 2499, inst: ETH_SPOT, leverage: 3, settings: S });
  assert.equal(c.qty, 0.2);
  // below exchange minimums
  assert.equal(positionSize({ capital: 10, entry: 60000, stop: 59000, inst: BTC, leverage: 1, settings: S }).qty, 0);
});

test('liquidation guard and daily guards', () => {
  assert.equal(liquidationBlock({ entry: 100, stop: 97, leverage: 3 }), null); // 3% vs ~33% liq
  assert.match(liquidationBlock({ entry: 100, stop: 93, leverage: 10 }), /liquidation/); // 7% vs ~9.5% liquidation distance
  assert.equal(liquidationBlock({ entry: 100, stop: 95, leverage: 10 }), null); // 5% is inside 60% of it
  const day = { trades: 0, netPnl: 0 };
  assert.equal(entryBlockReason({ day, openCount: 0, capital: 100, settings: S }), null);
  assert.match(entryBlockReason({ day, openCount: 2, capital: 100, settings: S }), /open positions/);
  assert.match(entryBlockReason({ day: { trades: 6, netPnl: 0 }, openCount: 0, capital: 100, settings: S }), /per day/);
  assert.match(entryBlockReason({ day: { trades: 1, netPnl: -4 }, openCount: 0, capital: 100, settings: S }), /loss limit/);
  assert.match(entryBlockReason({ day, openCount: 0, cooling: true, capital: 100, settings: S }), /cooling/);
});

test('fees: taker + GST per side; TDS only on spot sells', () => {
  const f = roundTripFees({ kind: 'futures', entryValue: 1000, exitValue: 1000, fees: S.fees });
  assert.equal(f, 1.18); // 2000 × 0.05% × 1.18
  const s = roundTripFees({ kind: 'spot', entryValue: 100, exitValue: 110, fees: S.fees });
  assert.equal(s, 0.4956); // 210 × 0.2% × 1.18
  assert.equal(spotTds({ kind: 'spot', exitValue: 110, fees: S.fees }), 1.1);
  assert.equal(spotTds({ kind: 'futures', exitValue: 110, fees: S.fees }), 0);
  assert.ok(Math.abs(roundTripCostPct('futures', S.fees) - 0.118) < 1e-12);
});

test('settings validation', () => {
  assert.equal(validateSettings({ timeframe: 30 }, S).timeframe, 30);
  assert.throws(() => validateSettings({ timeframe: 7 }, S));
  assert.throws(() => validateSettings({ spotSymbols: ['BTCINR'] }, S), /USDT/);
  assert.throws(() => validateSettings({ futuresPairs: ['BTCUSDT'] }, S));
  assert.throws(() => validateSettings({ market: 'spot', spotSymbols: [] }, S), /spot symbol/);
  assert.deepEqual(validateSettings({ futuresPairs: ['b-btc_usdt', 'B-BTC_USDT'] }, S).futuresPairs, ['B-BTC_USDT']);
  assert.equal(validateSettings({ futures: { leverage: 5 } }, S).futures.allowShorts, true);
});

test('rate limiter enforces per-second cap', async () => {
  const rl = new RateLimiter({ perSecond: 3, perMinute: 100 });
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await rl.acquire();
  assert.ok(Date.now() - t0 >= 900, '4th call waits for the window');
  assert.equal(rl.usage().lastMinute, 4);
});

test('paper broker: market fill with slippage, stop-market triggers on cross', async () => {
  const prices = new Map([[BTC.id, 60000]]);
  const md = { ltp: (id) => prices.get(id) };
  const b = new PaperBroker({ marketData: md, slippageBps: 10 });
  const entry = await b.placeOrder({ inst: BTC, side: 'BUY', qty: 0.01, orderType: 'MARKET' });
  assert.equal((await b.getOrder(entry.orderId)).avgPrice, 60060);
  const stop = await b.placeStop({ side: 'BUY', qty: 0.01 }, BTC, 59000);
  b.onTick(BTC.id, 59500);
  assert.equal((await b.getOrder(stop.stopId)).status, 'OPEN');
  // move the stop up, then gap through it
  await b.moveStop({ stopId: stop.stopId, side: 'BUY', qty: 0.01 }, BTC, 59600);
  b.onTick(BTC.id, 59400);
  const st = await b.getOrder(stop.stopId);
  assert.equal(st.status, 'FILLED');
  assert.equal(st.avgPrice, 59340.6); // gap fill below the stop, minus slippage
  // cancelling a filled stop reports FILLED (no double exit)
  assert.equal((await b.cancelStop({ stopId: stop.stopId })).status, 'FILLED');
  // limit buy fills only when marketable
  const lim = await b.placeOrder({ inst: BTC, side: 'BUY', qty: 0.01, orderType: 'LIMIT', price: 59000 });
  assert.equal((await b.getOrder(lim.orderId)).status, 'OPEN');
  b.onTick(BTC.id, 58900);
  assert.equal((await b.getOrder(lim.orderId)).status, 'FILLED');
});
