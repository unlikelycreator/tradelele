import crypto from 'node:crypto';
import { col } from '../db.js';
import { bus, log } from '../lib/bus.js';
import { roundTripCostPct, roundTripFees, spotTds } from '../lib/fees.js';
import { barStart, istDate } from '../lib/time.js';
import { roundPrice } from '../data/instruments.js';
import { breakoutSignal, indicators, minCandles, pnl, stopAndTarget, trailStop } from '../strategy/breakout.js';
import { waitForFill, sleep } from '../broker/orders.js';
import { entryBlockReason, liquidationBlock, positionSize } from './risk.js';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const LIVE_STATES = ['PENDING', 'OPEN', 'CLOSING'];
const COMPLETED_DAY_MS = 20 * 3600_000; // a paper "day" counts once the bot ran ≥ 20 h of it
const fmtPx = (x) => (x == null ? '—' : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));

/**
 * The trading engine: one instance runs for the lifetime of the process.
 *  - every candle close (default 15 m) it fetches candles for each instrument and looks for breakouts
 *  - every price tick it manages open positions (target, stop, breakeven trail)
 *  - a 1-second loop handles day rollover, exchange-stop monitoring, loss limit and time stops
 */
export class Engine {
  constructor({ clock, marketData, feed, broker, instruments, mode, requestedMode, modeBlockedReason, settings, capitalDefault, client, reviewer }) {
    this.clock = clock;
    this.md = marketData;
    this.feed = feed;
    this.broker = broker;
    this.registry = instruments;
    this.mode = mode; // 'paper' | 'live' | 'sim'
    this.requestedMode = requestedMode;
    this.modeBlockedReason = modeBlockedReason;
    this.settings = settings;
    this.capitalDefault = capitalDefault;
    this.client = client;
    this.reviewer = reviewer;
    this.paused = false;
    this.halted = false;
    this.haltReason = null;
    this.positions = new Map(); // tradeId → trade (PENDING / OPEN / CLOSING)
    this.held = new Map(); // instId → instrument snapshot of anything we hold (survives settings changes)
    this.inst = new Map(); // instId → { status, note, ind, lastBar, cooldownUntil, staleTries }
    this.stopChecks = new Map();
    this.nextScanAt = 0;
    this.scanning = false;
    this.lastStepAt = null;
    this.#resetDay(istDate(clock.now()));
  }

  get capital() {
    return this.settings.capital ?? this.capitalDefault;
  }

  get tfMs() {
    return this.settings.timeframe * 60_000;
  }

  #instrument(id) {
    return this.registry.get(id) || this.held.get(id);
  }

  #state(id) {
    if (!this.inst.has(id)) this.inst.set(id, { status: 'warming_up', note: 'loading candles…' });
    return this.inst.get(id);
  }

  #resetDay(date) {
    this.date = date;
    this.day = { trades: 0, wins: 0, losses: 0, grossPnl: 0, fees: 0, tds: 0, netPnl: 0, activeMs: 0, lossHit: false, finalized: false };
    this.halted = false;
    this.haltReason = null;
  }

  /** Feed prices for the configured instruments plus anything still held. */
  #syncFeed() {
    const list = [...this.registry.list()];
    for (const [id, i] of this.held) if (!this.registry.get(id) && [...this.positions.values()].some((t) => t.instId === id)) list.push(i);
    this.feed.setInstruments(list);
  }

  // ── lifecycle ────────────────────────────────────────────

  async start() {
    await this.registry.sync(this.settings, (id) => this.md.ltp(id));
    await this.#recover();
    this.#syncFeed();
    this.md.on('tick', (id, ltp) => this.#onTick(id, ltp));
    this.feed.start();
    this.loop = setInterval(() => this.#step().catch((e) => log('error', `Engine step failed: ${e.message}`)), 1000);
    this.stateTimer = setInterval(() => bus.emit('state', this.snapshot()), 1000);
    const s = this.settings;
    const what = s.market === 'both' ? 'spot + futures' : s.market;
    log('info', `Engine started in ${this.mode.toUpperCase()} mode · ${what} · ${this.registry.list().length} instruments · ${s.timeframe}m candles · capital ${this.capital} USDT${s.market !== 'spot' ? ` · futures ${s.futures.leverage}×` : ''}`);
    if (this.modeBlockedReason) log('warn', this.modeBlockedReason);
  }

  stop() {
    clearInterval(this.loop);
    clearInterval(this.stateTimer);
    this.feed.stop();
  }

  /** Reload trades after a restart so open positions keep being managed. */
  async #recover() {
    const today = await col('trades').find({ date: this.date, mode: this.mode }).toArray();
    for (const t of today) {
      if (t.status === 'CLOSED') this.#addToDay(t);
      if (t.status !== 'FAILED') this.day.trades++;
    }
    const daily = await col('daily').findOne({ date: this.date, mode: this.mode });
    if (daily?.activeMinutes) this.day.activeMs = daily.activeMinutes * 60_000;

    const live = await col('trades').find({ mode: this.mode, status: { $in: LIVE_STATES } }).toArray();
    for (const t of live) {
      if (t.status === 'PENDING' && !t.entryPrice) {
        const note = this.broker.kind === 'live' ? 'restart before the entry was confirmed — CHECK YOUR COINDCX ACCOUNT' : 'restart before fill';
        await this.#update(t, { status: 'FAILED', note });
        if (this.broker.kind === 'live') log('error', `${t.label}: ${note}`);
        continue;
      }
      t.status = 'OPEN';
      t.busy = false;
      this.positions.set(t._id, t);
      this.held.set(t.instId, t.inst);
      if (!this.broker.stopsSurviveRestart || !t.stopId) await this.#placeProtectiveStop(t, t.inst);
      await this.#update(t, {});
      log('warn', `Recovered open ${t.side === 'BUY' ? 'LONG' : 'SHORT'} ${t.label} × ${t.qty} after restart`);
    }
  }

  // ── main loop ────────────────────────────────────────────

  async #step() {
    const now = this.clock.now();
    const date = istDate(now);
    if (date !== this.date) {
      if (!this.day.finalized) await this.#finalizeDay();
      this.#resetDay(date);
      log('info', `New IST day ${date} — daily counters reset`);
    }
    if (this.lastStepAt) this.day.activeMs += Math.min(now - this.lastStepAt, 5000 * this.clock.speed);
    if (!this.lastSaveAt || now - this.lastSaveAt >= 60_000) {
      this.lastSaveAt = now;
      await this.#saveDaily().catch(() => {});
    }
    this.lastStepAt = now;

    if (now.getTime() >= this.nextScanAt && !this.scanning) {
      this.scanning = true;
      this.#scan()
        .catch((e) => log('error', `Candle scan failed: ${e.message}`))
        .finally(() => (this.scanning = false));
    }

    await this.#monitorStops();

    // daily loss guard (realized + open P&L)
    const lossLimit = (this.capital * this.settings.maxDailyLossPct) / 100;
    if (!this.day.lossHit && this.day.netPnl + this.#unrealized() <= -lossLimit) {
      this.day.lossHit = true;
      log('error', `Daily loss limit ${lossLimit.toFixed(2)} USDT reached — closing positions, no new trades until the next IST day`);
      await this.squareOffAll('daily loss limit');
    }

    // time stop
    const maxHold = this.settings.maxHoldHours * 3600_000;
    if (maxHold > 0) {
      for (const t of this.positions.values()) {
        if (t.status === 'OPEN' && !t.busy && t.entryAt && now - new Date(t.entryAt) >= maxHold) await this.exit(t, 'time stop');
      }
    }
  }

  /** Fetch candles for every instrument after each candle close and evaluate them. */
  async #scan() {
    const s = this.settings;
    const now = this.clock.now().getTime();
    const currentBar = barStart(now, s.timeframe);
    const expectedLast = currentBar - this.tfMs;
    const limit = Math.min(500, Math.max(150, minCandles(s) * 2));
    let stale = false;
    for (const inst of this.registry.list()) {
      const st = this.#state(inst.id);
      if (inst.active === false) {
        Object.assign(st, { status: 'skipped', note: 'market not active on CoinDCX' });
        continue;
      }
      let candles;
      try {
        candles = await this.feed.candles(inst, s.timeframe, limit);
      } catch (e) {
        if (st.note !== `candles: ${e.message}`) log('warn', `${inst.label}: candle fetch failed — ${e.message}`);
        Object.assign(st, { status: 'error', note: `candles: ${e.message}` });
        continue;
      }
      this.md.setCandles(inst.id, candles, s.timeframe);
      const closed = candles.filter((c) => c.time + this.tfMs <= now);
      const last = closed[closed.length - 1];
      if (!last) continue;
      if (last.time < expectedLast && (st.staleTries || 0) < 3) {
        st.staleTries = (st.staleTries || 0) + 1;
        stale = true; // the exchange hasn't published the closed candle yet
        continue;
      }
      st.staleTries = 0;
      const ind = indicators(closed, s);
      st.ind = ind;
      if (!ind) {
        Object.assign(st, { status: 'warming_up', note: `${closed.length}/${minCandles(s)} candles` });
        continue;
      }
      if (st.lastBar === last.time) continue;
      st.lastBar = last.time;
      await this.#onCandle(inst, ind, st);
    }
    this.nextScanAt = stale ? now + 10_000 : currentBar + this.tfMs + 4000;
  }

  async #onCandle(inst, ind, st) {
    const open = [...this.positions.values()].find((t) => t.instId === inst.id);
    if (open) {
      // ATR trail is evaluated on candle closes (fewer stop modifications than per tick)
      if (open.status === 'OPEN' && !open.busy && this.settings.trailAtr > 0) {
        const next = this.#trailFor(open, ind.close, ind.atr, this.settings);
        if (next != null) await this.#moveStop(open, next, `ATR trail → ${fmtPx(next)}`);
      }
      Object.assign(st, { status: 'in_trade', note: `${open.side === 'BUY' ? 'long' : 'short'} ${open.qty}` });
      return;
    }
    await this.#tryEnter(inst, ind, st);
  }

  // ── entries ──────────────────────────────────────────────

  async #tryEnter(inst, ind, st) {
    const s = this.settings;
    const now = this.clock.now().getTime();
    if (this.paused || this.halted || this.day.lossHit) {
      Object.assign(st, { status: 'paused', note: this.halted ? 'halted' : this.day.lossHit ? 'daily loss limit hit' : 'paused' });
      return;
    }
    const sig = breakoutSignal(ind, s, { allowShort: inst.kind === 'futures' && s.futures.allowShorts });
    if (!sig) {
      Object.assign(st, { status: 'watching', note: '' }); // channel, ATR and trend are their own columns
      return;
    }
    if (sig.blocked) {
      if (st.note !== sig.reason) log('info', `${inst.label}: skipped — ${sig.reason}`);
      Object.assign(st, { status: 'watching', note: sig.reason });
      return;
    }
    const blocked = entryBlockReason({
      day: { trades: this.day.trades, netPnl: this.day.netPnl + this.#unrealized() },
      openCount: this.positions.size,
      hasPosition: false,
      cooling: (st.cooldownUntil || 0) > now,
      capital: this.capital,
      settings: s,
    });
    if (blocked) {
      if (st.note !== blocked) log('info', `${inst.label}: ${sig.side === 'BUY' ? 'long' : 'short'} signal ignored — ${blocked}`);
      Object.assign(st, { status: 'watching', note: blocked });
      return;
    }

    const roundPx = (x, dir) => roundPrice(inst, x, dir);
    const ref = this.md.ltp(inst.id) ?? ind.close;
    const lev = inst.kind === 'futures' ? Math.min(s.futures.leverage, inst.maxLeverage || Infinity) : 1;
    const plan = stopAndTarget({ side: sig.side, entry: ref, atr: ind.atr, settings: s, roundPx });
    const liq = inst.kind === 'futures' ? liquidationBlock({ entry: ref, stop: plan.stop, leverage: lev }) : null;
    const size = liq ? { qty: 0, reason: liq } : positionSize({ capital: this.capital, entry: ref, stop: plan.stop, inst, leverage: lev, settings: s });
    if (!size.qty) {
      if (st.note !== size.reason) log('info', `${inst.label}: ${sig.side === 'BUY' ? 'long' : 'short'} signal skipped — ${size.reason}`);
      Object.assign(st, { status: 'watching', note: size.reason });
      return;
    }

    this.day.trades++;
    const trade = {
      _id: crypto.randomUUID(),
      date: this.date,
      mode: this.mode,
      instId: inst.id,
      inst: { ...inst },
      kind: inst.kind,
      symbol: inst.symbol,
      label: inst.label,
      side: sig.side,
      qty: size.qty,
      leverage: lev,
      status: 'PENDING',
      signal: sig.reason,
      timeframe: s.timeframe,
      atr: r4(ind.atr),
      channel: { high: ind.channelHigh, low: ind.channelLow },
      plannedEntry: ref,
      openedAt: this.clock.now(),
      busy: true,
    };
    this.positions.set(trade._id, trade);
    this.held.set(inst.id, trade.inst);
    Object.assign(st, { status: 'in_trade', note: `${sig.side === 'BUY' ? 'long' : 'short'} ${size.qty}` });
    await col('trades').insertOne(this.#persistable(trade));
    log(
      'signal',
      `${inst.label}: ${sig.side === 'BUY' ? 'LONG' : 'SHORT'} breakout — ${sig.reason}. Sizing ${size.qty} (${size.notional} USDT notional${lev > 1 ? `, ${size.margin} margin at ${lev}×` : ''}, risk ${size.riskAmount} USDT, limited by ${size.limitedBy})`,
    );

    try {
      await this.broker.prepare(inst, s);
      const placed = await this.broker.placeOrder({ inst, side: sig.side, qty: size.qty, orderType: 'MARKET', leverage: lev });
      trade.entryOrderId = placed.orderId;
      const fill = await waitForFill(this.broker, placed.orderId, inst, this.broker.kind === 'live' ? 15_000 : 2000);
      const filledQty = fill.status === 'FILLED' ? fill.filledQty || size.qty : fill.filledQty;
      if (!(filledQty > 0)) throw new Error(`entry order ${fill.status}${fill.remark ? `: ${fill.remark}` : ''}`);

      const entry = fill.avgPrice || this.md.ltp(inst.id) || ref;
      const qty = this.broker.sellableQty ? await this.broker.sellableQty(inst, filledQty) : filledQty;
      const p = stopAndTarget({ side: sig.side, entry, atr: ind.atr, settings: s, roundPx });
      Object.assign(trade, { qty, entryPrice: entry, entryAt: this.clock.now(), stop: p.stop, initialStop: p.stop, target: p.target, initialRisk: p.risk, ltp: entry, status: 'OPEN' });
      await this.#placeProtectiveStop(trade, inst);
      await this.#update(trade, {});
      log('entry', `ENTRY ${sig.side === 'BUY' ? 'LONG' : 'SHORT'} ${inst.label} × ${qty} @ ${fmtPx(entry)} · SL ${fmtPx(trade.stop)} · target ${fmtPx(trade.target)}${trade.softStop ? ' · stop watched by the bot' : ''}`, { tradeId: trade._id });
    } catch (err) {
      this.positions.delete(trade._id);
      this.day.trades--;
      await this.#update(trade, { status: 'FAILED', note: err.message });
      Object.assign(st, { status: 'watching', note: `entry failed: ${err.message}` });
      log('error', `${inst.label}: entry failed — ${err.message}`);
      this.#syncFeed();
    } finally {
      trade.busy = false;
    }
  }

  /** Protective stop at the exchange, so the position is protected even if this bot stops. */
  async #placeProtectiveStop(trade, inst) {
    try {
      const r = await this.broker.placeStop(trade, inst, trade.stop);
      Object.assign(trade, { stopId: r.stopId, positionId: r.positionId ?? trade.positionId, stopType: r.type, softStop: false });
    } catch (e) {
      Object.assign(trade, { stopId: null, stopType: null, softStop: true });
      log(inst.kind === 'spot' && !inst.stopLimit ? 'warn' : 'error', `${trade.label}: no exchange stop (${e.message}) — the bot watches the stop itself`);
    }
  }

  // ── position management ─────────────────────────────────

  #onTick(id, ltp) {
    this.broker.onTick(id, ltp); // paper: trigger simulated stop orders
    this.registry.refineDefaults(id, ltp);
    for (const t of this.positions.values()) {
      if (t.instId !== id || t.status !== 'OPEN') continue;
      t.ltp = ltp;
      if (t.busy) continue;
      this.#manage(t, ltp).catch((e) => log('error', `${t.label}: manage failed — ${e.message}`));
    }
  }

  #stopReason(t) {
    return t.trailed ? 'trailing stop' : 'stop loss';
  }

  #trailFor(t, price, atr, settings) {
    const roundPx = (x, dir) => roundPrice(t.inst, x, dir);
    return trailStop({ side: t.side, entry: t.entryPrice, stop: t.stop, initialRisk: t.initialRisk, price, atr, settings, costPct: roundTripCostPct(t.kind, settings.fees), roundPx });
  }

  async #manage(t, ltp) {
    // paper stop orders fill synchronously in onTick; pick that up immediately
    if (this.broker.kind === 'paper' && t.stopId) {
      const st = await this.broker.getOrder(t.stopId);
      if (st.status === 'FILLED') return this.#closeWhileBusy(t, st.avgPrice, this.#stopReason(t));
    }
    const long = t.side === 'BUY';
    if (long ? ltp >= t.target : ltp <= t.target) return this.exit(t, 'target');

    // bot-side stop: always for soft stops; in live, also a backup if the exchange stop lags badly
    const slack = t.softStop ? 0 : 0.005 * t.stop;
    if ((t.softStop || this.broker.kind === 'live') && (long ? ltp <= t.stop - slack : ltp >= t.stop + slack)) return this.exit(t, this.#stopReason(t));

    // breakeven move on ticks; the ATR trail runs on candle closes
    if (!t.trailed && (!t.trailFailedAt || Date.now() - t.trailFailedAt > 60_000)) {
      const next = this.#trailFor(t, ltp, 0, { ...this.settings, trailAtr: 0 });
      if (next != null) await this.#moveStop(t, next, `+${this.settings.trailToBreakevenAtR}R reached — stop moved to breakeven ${fmtPx(next)}`);
    }
  }

  async #closeWhileBusy(t, price, reason) {
    t.busy = true;
    try {
      await this.#closeTrade(t, price, reason);
    } finally {
      t.busy = false;
    }
  }

  async #moveStop(t, next, message) {
    t.busy = true;
    try {
      if (t.stopId) {
        const r = await this.broker.moveStop(t, t.inst, next);
        if (r.filled) return await this.#closeTrade(t, r.avgPrice ?? t.ltp, this.#stopReason(t));
        Object.assign(t, { stopId: r.stopId, positionId: r.positionId ?? t.positionId, stopType: r.type });
      }
      t.stop = next;
      t.trailed = true;
      await this.#update(t, {});
      log('info', `${t.label}: ${message}`);
    } catch (e) {
      t.trailFailedAt = Date.now();
      log('warn', `${t.label}: could not move stop — ${e.message} (the previous stop still protects the trade)`);
      if (!t.stopId && !t.softStop) await this.#placeProtectiveStop(t, t.inst).catch(() => {});
    } finally {
      t.busy = false;
    }
  }

  /** Live: poll each exchange stop (every 5 s per position). */
  async #monitorStops() {
    if (this.broker.kind !== 'live') return;
    for (const t of this.positions.values()) {
      if (t.status !== 'OPEN' || t.busy || t.softStop || !t.stopId) continue;
      if (Date.now() - (this.stopChecks.get(t._id) || 0) < 5000) continue;
      this.stopChecks.set(t._id, Date.now());
      t.busy = true;
      try {
        const st = await this.broker.stopStatus(t, t.inst);
        if (st.status === 'FILLED') await this.#closeTrade(t, st.avgPrice || t.ltp, this.#stopReason(t));
        else if (st.status === 'REJECTED' || st.status === 'CANCELLED') {
          log('warn', `${t.label}: exchange stop ${st.status.toLowerCase()}${st.remark ? ` (${st.remark})` : ''} — re-placing`);
          await this.#placeProtectiveStop(t, t.inst);
          await this.#update(t, {});
        }
      } catch (e) {
        log('warn', `${t.label}: stop check failed — ${e.message}`);
      } finally {
        t.busy = false;
      }
    }
  }

  /** Exit a position at market: make sure the exchange stop can't also fire first. */
  async exit(t, reason) {
    if (t.busy || t.status !== 'OPEN') return;
    t.busy = true;
    t.status = 'CLOSING';
    const inst = t.inst;
    try {
      if (t.stopId) {
        const st = await this.broker.cancelStop(t, inst);
        if (st.status === 'FILLED') return await this.#closeTrade(t, st.avgPrice || t.ltp, this.#stopReason(t));
        if (st.status === 'OPEN') throw new Error('stop order could not be cancelled');
        t.stopId = null; // from here on only our exit orders are working
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const remaining = r4(t.qty - (t.exitFilledQty || 0));
        const px = this.md.ltp(t.instId) ?? t.ltp ?? t.entryPrice;
        if (remaining <= 0 || ((t.exitFilledQty || 0) > 0 && remaining * px < inst.minNotional)) break; // done, or unsellable dust
        const r = await this.broker.exitPosition(t, inst, remaining);
        if (r.filledQty > 0) {
          t.exitFilledQty = r4((t.exitFilledQty || 0) + r.filledQty);
          t.exitValue = (t.exitValue || 0) + r.filledQty * (r.avgPrice || px);
        }
      }
      const left = r4(t.qty - (t.exitFilledQty || 0));
      const px = this.md.ltp(t.instId) ?? t.ltp;
      if (left > 0 && !((t.exitFilledQty || 0) > 0 && left * px < inst.minNotional)) throw new Error(`${left} still open after exit orders`);
      // fee dust that can't be sold is valued at the last price
      await this.#closeTrade(t, px, reason);
    } catch (e) {
      t.status = 'OPEN';
      t.exitFailures = (t.exitFailures || 0) + 1;
      log('error', `${t.label}: exit (${reason}) failed — ${e.message}`);
      // never leave the position unprotected while we retry
      if (!t.stopId) await this.#placeProtectiveStop(t, inst).catch(() => {});
      await this.#update(t, {}).catch(() => {});
      if (t.exitFailures >= 3) this.#halt(`Could not exit ${t.label} after 3 attempts — CHECK YOUR COINDCX ACCOUNT`);
      await sleep(2000);
    } finally {
      t.busy = false;
    }
  }

  /** `exitPrice` applies to whatever quantity our own exit orders haven't already closed. */
  async #closeTrade(t, exitPrice, reason) {
    if (!this.positions.has(t._id)) return;
    const done = t.exitFilledQty || 0;
    const rest = Math.max(0, t.qty - done);
    const px = exitPrice ?? this.md.ltp(t.instId) ?? t.ltp ?? t.entryPrice;
    const exit = ((t.exitValue || 0) + rest * px) / t.qty;
    const gross = r4(pnl(t.side, t.entryPrice, exit, t.qty));
    const fees = roundTripFees({ kind: t.kind, entryValue: t.entryPrice * t.qty, exitValue: exit * t.qty, fees: this.settings.fees });
    const tds = spotTds({ kind: t.kind, exitValue: exit * t.qty, fees: this.settings.fees });
    const net = r4(gross - fees);
    this.positions.delete(t._id);
    const patch = {
      status: 'CLOSED',
      exitPrice: +exit.toPrecision(10),
      exitAt: this.clock.now(),
      exitReason: reason,
      grossPnl: gross,
      fees,
      tds,
      netPnl: net,
      rMultiple: t.initialRisk ? Math.round((gross / t.qty / t.initialRisk) * 100) / 100 : null,
    };
    await this.#update(t, patch);
    this.#addToDay(t);
    const st = this.#state(t.instId);
    Object.assign(st, { status: 'cooldown', note: `${reason} · ${net >= 0 ? '+' : ''}${net} USDT`, cooldownUntil: this.clock.now().getTime() + this.settings.cooldownBars * this.tfMs });
    await this.#saveDaily();
    this.#syncFeed();
    log('exit', `EXIT ${t.label} @ ${fmtPx(exit)} (${reason}) · net ${net >= 0 ? '+' : ''}${net} USDT after ${fees} fees${tds ? ` · TDS withheld ${tds}` : ''}`, { tradeId: t._id });
  }

  #addToDay(t) {
    const d = this.day;
    d.grossPnl = r4(d.grossPnl + t.grossPnl);
    d.fees = r4(d.fees + (t.fees || 0));
    d.tds = r4(d.tds + (t.tds || 0));
    d.netPnl = r4(d.netPnl + t.netPnl);
    if (t.netPnl > 0) d.wins++;
    else d.losses++;
  }

  async squareOffAll(reason) {
    const open = [...this.positions.values()].filter((t) => t.status === 'OPEN');
    await Promise.all(open.map((t) => this.exit(t, reason)));
  }

  // ── day bookkeeping ──────────────────────────────────────

  async #saveDaily() {
    const d = this.day;
    await col('daily').updateOne(
      { date: this.date, mode: this.mode },
      {
        $set: {
          trades: d.wins + d.losses,
          wins: d.wins,
          losses: d.losses,
          grossPnl: d.grossPnl,
          fees: d.fees,
          tds: d.tds,
          netPnl: d.netPnl,
          capital: this.capital,
          activeMinutes: Math.round(d.activeMs / 60_000),
          completed: d.activeMs >= COMPLETED_DAY_MS,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async #finalizeDay() {
    this.day.finalized = true;
    await this.#saveDaily();
    const d = this.day;
    log('info', `IST day ${this.date} closed · ${d.wins + d.losses} trades · ${d.wins}W/${d.losses}L · net ${d.netPnl} USDT · bot active ${Math.round(d.activeMs / 3600_000)}h`);
    if (this.reviewer?.enabled && d.wins + d.losses > 0) {
      this.reviewer.reviewDay(this.date, this.mode).catch((e) => log('warn', `Gemini review failed: ${e.message}`));
    }
  }

  // ── controls ─────────────────────────────────────────────

  #halt(reason) {
    this.halted = true;
    this.haltReason = reason;
    log('error', reason);
  }

  pause() {
    this.paused = true;
    log('warn', 'Trading paused from dashboard — no new entries (open positions still managed)');
  }

  resume() {
    this.paused = false;
    if (this.halted) {
      this.halted = false;
      this.haltReason = null;
    }
    log('info', 'Trading resumed from dashboard');
  }

  async killSwitch() {
    this.paused = true;
    log('error', 'KILL SWITCH — closing all positions at market and pausing');
    await this.squareOffAll('kill switch');
  }

  async closePosition(id) {
    const t = this.positions.get(id);
    if (!t) throw new Error('Position not found');
    await this.exit(t, 'manual close');
  }

  async applySettings(next) {
    const tfChanged = next.timeframe !== this.settings.timeframe;
    this.settings = next;
    if (this.broker.kind === 'paper') this.broker.slippageBps = next.paperSlippageBps;
    await this.registry.sync(next, (id) => this.md.ltp(id));
    if (tfChanged) this.inst.clear();
    for (const id of [...this.inst.keys()]) if (!this.registry.get(id)) this.inst.delete(id);
    for (const st of this.inst.values()) st.lastBar = null; // re-evaluate with the new parameters
    this.nextScanAt = 0;
    this.#syncFeed();
    log('info', `Strategy settings updated from dashboard (${next.market}, ${next.timeframe}m candles, ${this.registry.list().length} instruments)`);
  }

  // ── persistence helpers ──────────────────────────────────

  #persistable(t) {
    const { busy, ltp, exitFailures, trailFailedAt, ...rest } = t;
    return rest;
  }

  async #update(t, patch) {
    Object.assign(t, patch);
    const { _id, ...doc } = this.#persistable(t);
    await col('trades').updateOne({ _id }, { $set: { ...doc, updatedAt: new Date() } });
  }

  #unrealized() {
    let u = 0;
    for (const t of this.positions.values()) if (t.entryPrice && t.ltp) u += pnl(t.side, t.entryPrice, t.ltp, t.qty);
    return r4(u);
  }

  // ── dashboard snapshot ───────────────────────────────────

  snapshot() {
    const now = this.clock.now();
    const unrealized = this.#unrealized();
    const s = this.settings;
    const warming = this.registry.list().some((i) => !this.inst.get(i.id)?.ind);
    const enginePhase = this.halted ? 'halted' : this.paused ? 'paused' : this.day.lossHit ? 'loss_limit' : warming ? 'warming_up' : this.positions.size ? 'managing' : 'hunting';
    return {
      now: now.toISOString(),
      date: this.date,
      mode: this.mode,
      requestedMode: this.requestedMode,
      modeBlockedReason: this.modeBlockedReason,
      enginePhase,
      paused: this.paused,
      halted: this.halted,
      haltReason: this.haltReason,
      capital: this.capital,
      currency: 'USDT',
      usdtInr: this.md.usdtInr,
      day: {
        trades: this.day.trades,
        closed: this.day.wins + this.day.losses,
        wins: this.day.wins,
        losses: this.day.losses,
        grossPnl: this.day.grossPnl,
        fees: this.day.fees,
        tds: this.day.tds,
        realized: this.day.netPnl,
        unrealized,
        total: r4(this.day.netPnl + unrealized),
        lossLimit: r4((this.capital * s.maxDailyLossPct) / 100),
        lossHit: this.day.lossHit,
        activeHours: Math.round((this.day.activeMs / 3600_000) * 10) / 10,
      },
      positions: [...this.positions.values()].map((t) => ({
        id: t._id,
        instId: t.instId,
        label: t.label,
        kind: t.kind,
        side: t.side,
        qty: t.qty,
        leverage: t.leverage,
        status: t.status,
        entryPrice: t.entryPrice,
        stop: t.stop,
        target: t.target,
        ltp: t.ltp,
        trailed: !!t.trailed,
        softStop: !!t.softStop,
        stopType: t.stopType,
        unrealized: t.entryPrice && t.ltp ? r4(pnl(t.side, t.entryPrice, t.ltp, t.qty)) : 0,
        entryAt: t.entryAt,
      })),
      instruments: this.registry.list().map((i) => {
        const st = this.inst.get(i.id) || {};
        const ind = st.ind;
        const cooling = (st.cooldownUntil || 0) > now.getTime();
        return {
          id: i.id,
          label: i.label,
          kind: i.kind,
          ltp: this.md.ltp(i.id),
          change24h: this.md.change24h(i.id),
          channelHigh: ind?.channelHigh ?? null,
          channelLow: ind?.channelLow ?? null,
          ema: ind?.ema ?? null,
          atrPct: ind ? Math.round(ind.atrPct * 100) / 100 : null,
          trend: ind?.trend ?? null,
          status: st.status === 'cooldown' && !cooling ? 'watching' : st.status || 'warming_up',
          note: st.note || '',
          rules: i.rules,
        };
      }),
      strategy: {
        market: s.market,
        timeframe: s.timeframe,
        channelBars: s.channelBars,
        emaPeriod: s.emaPeriod,
        leverage: s.futures.leverage,
        nextScanAt: this.nextScanAt ? new Date(this.nextScanAt).toISOString() : null,
      },
      feed: this.feed.status(),
      rateLimits: this.client ? this.client.usage() : [],
      reviewer: !!this.reviewer?.enabled,
    };
  }
}
