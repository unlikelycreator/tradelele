import { config } from '../config.js';
import { col } from '../db.js';
import { log } from '../lib/bus.js';

/**
 * Optional Gemini integration — deliberately kept OFF the trading path.
 *
 * An LLM is slow (seconds), non-deterministic and impossible to backtest, so it never
 * places, sizes or blocks a trade. It only writes an end-of-day review of what the rule-based
 * engine did: a trading journal you would otherwise have to write yourself.
 */
export class GeminiReviewer {
  constructor({ apiKey = config.gemini.apiKey, model = config.gemini.model, getSettings }) {
    this.apiKey = apiKey;
    this.model = model;
    this.getSettings = getSettings;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async reviewDay(date, mode) {
    if (!this.enabled) throw new Error('GEMINI_API_KEY is not set');
    const [trades, recentDays, events] = await Promise.all([
      col('trades').find({ date, mode, status: 'CLOSED' }).sort({ openedAt: 1 }).toArray(),
      col('daily').find({ mode }).sort({ date: -1 }).limit(20).toArray(),
      col('events').find({ tsDate: { $gte: new Date(Date.now() - 24 * 3600_000) }, level: { $in: ['warn', 'error'] } }).limit(40).toArray(),
    ]);
    const settings = this.getSettings();

    const prompt = `You are reviewing one day (IST calendar day) of an automated 24×7 crypto trading bot on CoinDCX (India).
Strategy: trend-filtered channel breakout on ${settings.timeframe}-minute candles (close beyond the ${settings.channelBars}-candle high/low, trend filter EMA${settings.emaPeriod}),
stop ${settings.stopAtr}×ATR (max ${settings.maxStopPct}%), target ${settings.rewardRisk}R, breakeven after ${settings.trailToBreakevenAtR}R. Fixed rules, no discretion.
Markets: ${settings.market} (futures are USDT-margined perpetuals at ${settings.futures.leverage}× leverage; spot is long-only). Amounts are in USDT.
Mode: ${mode} (paper = simulated fills on real CoinDCX prices).

Settings: ${JSON.stringify(settings)}

Today's closed trades (${date}):
${JSON.stringify(trades.map((t) => ({ instrument: t.label, side: t.side, qty: t.qty, entry: t.entryPrice, exit: t.exitPrice, stop: t.initialStop, target: t.target, reason: t.exitReason, net: t.netPnl, fees: t.fees, r: t.rMultiple, entryAt: t.entryAt, exitAt: t.exitAt })), null, 0)}

Recent daily results (newest first): ${JSON.stringify(recentDays.map((d) => ({ date: d.date, trades: d.trades, net: d.netPnl, wins: d.wins, losses: d.losses })))}

Warnings/errors logged in the last 24h: ${JSON.stringify(events.map((e) => e.message))}

Write a concise trading-journal review in markdown with these sections:
1. **Summary** — 2-3 sentences.
2. **What worked / what didn't** — refer to specific trades.
3. **Execution issues** — slippage, fees vs. profit, failed orders, API errors, if any.
4. **Observations** — patterns across recent days (only if the sample supports it).
5. **Suggestions** — at most 2, conservative. State clearly that fewer than ~50 trades is too small a sample to change parameters, and never suggest increasing risk or leverage to recover losses.
Keep it under 350 words. No hype, no price predictions.`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Gemini HTTP ${res.status}`);
    const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty review');

    await col('reviews').updateOne({ _id: `${mode}:${date}` }, { $set: { date, mode, text, model: this.model, createdAt: new Date() } }, { upsert: true });
    log('info', `Gemini end-of-day review ready for ${date}`);
    return { date, mode, text };
  }
}
