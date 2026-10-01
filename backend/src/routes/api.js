import { Router } from 'express';
import { col } from '../db.js';
import { bus } from '../lib/bus.js';
import { istDate } from '../lib/time.js';
import { saveSettings } from '../engine/settings.js';

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) =>
    res.status(e.name === 'ZodError' ? 400 : 500).json({ error: e.errors?.[0]?.message ? `${e.errors[0].path.join('.')}: ${e.errors[0].message}` : e.message }),
  );

export function apiRouter({ engine, reviewer, client, paperDays }) {
  const r = Router();

  r.get('/state', (req, res) => res.json({ ...engine.snapshot(), paperDays: paperDays() }));

  // Server-Sent Events: live engine state + decision log
  r.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('state', { ...engine.snapshot(), paperDays: paperDays() });
    const onState = (s) => send('state', { ...s, paperDays: paperDays() });
    const onLog = (e) => send('log', e);
    bus.on('state', onState);
    bus.on('log', onLog);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('state', onState);
      bus.off('log', onLog);
    });
  });

  r.get('/events', wrap(async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 150);
    res.json(await col('events').find({}, { projection: { _id: 0, tsDate: 0 } }).sort({ tsDate: -1 }).limit(limit).toArray());
  }));

  r.get('/trades', wrap(async (req, res) => {
    const q = { mode: String(req.query.mode || engine.mode) };
    if (req.query.date) q.date = String(req.query.date);
    if (req.query.instId) q.instId = String(req.query.instId);
    const limit = Math.min(1000, Number(req.query.limit) || 200);
    res.json(await col('trades').find(q).sort({ openedAt: -1 }).limit(limit).toArray());
  }));

  r.get('/daily', wrap(async (req, res) => {
    res.json(await col('daily').find({ mode: String(req.query.mode || engine.mode) }).sort({ date: 1 }).limit(500).toArray());
  }));

  r.get('/candles/:instId', wrap(async (req, res) => {
    const instId = String(req.params.instId);
    const snap = engine.snapshot();
    const inst = snap.instruments.find((i) => i.id === instId);
    const trades = await col('trades').find({ mode: engine.mode, instId, status: { $in: ['OPEN', 'CLOSING', 'CLOSED'] } }).sort({ openedAt: -1 }).limit(30).toArray();
    res.json({ instId, timeframe: engine.settings.timeframe, candles: engine.md.getCandles(instId), channel: inst ? { high: inst.channelHigh, low: inst.channelLow, ema: inst.ema } : null, trades });
  }));

  r.get('/settings', (req, res) => res.json(engine.settings));

  r.put('/settings', wrap(async (req, res) => {
    const next = await saveSettings(req.body || {}, engine.settings);
    await engine.applySettings(next);
    res.json(next);
  }));

  r.post('/control/pause', (req, res) => {
    engine.pause();
    res.json({ ok: true });
  });
  r.post('/control/resume', (req, res) => {
    engine.resume();
    res.json({ ok: true });
  });
  r.post('/control/kill', wrap(async (req, res) => {
    await engine.killSwitch();
    res.json({ ok: true });
  }));
  r.post('/control/close/:id', wrap(async (req, res) => {
    await engine.closePosition(req.params.id);
    res.json({ ok: true });
  }));

  r.get('/reviews', wrap(async (req, res) => {
    res.json(await col('reviews').find({ mode: String(req.query.mode || engine.mode) }).sort({ date: -1 }).limit(30).toArray());
  }));
  r.post('/reviews/run', wrap(async (req, res) => {
    if (!reviewer.enabled) return res.status(400).json({ error: 'Set GEMINI_API_KEY in backend/.env to enable reviews' });
    res.json(await reviewer.reviewDay(req.body?.date || istDate(engine.clock.now()), engine.mode));
  }));

  /** CoinDCX account snapshot: spot balances + open futures positions (read-only). */
  r.get('/account', wrap(async (req, res) => {
    if (!client?.hasKeys) return res.json({ connected: false, reason: engine.mode === 'sim' ? 'simulator' : 'no API keys in .env' });
    const [balances, positions] = await Promise.all([
      client.spotBalances().catch((e) => ({ error: e.message })),
      client.futuresPositions().catch((e) => ({ error: e.message })),
    ]);
    const nonZero = Array.isArray(balances) ? balances.filter((b) => +b.balance > 0 || +b.locked_balance > 0) : balances;
    const open = Array.isArray(positions) ? positions.filter((p) => +p.active_pos !== 0) : positions;
    res.json({ connected: !balances.error || !positions.error, balances: nonZero, positions: open });
  }));

  return r;
}
