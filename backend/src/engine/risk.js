import { floorQty } from '../data/instruments.js';

/**
 * Position sizing and daily risk guards — pure functions.
 *
 * qty = (capital × riskPerTradePct) / |entry − stop|, then capped so the margin used never
 * exceeds maxPositionPct of capital (futures notional = margin × leverage; spot has no leverage),
 * then rounded DOWN to the exchange quantity step. A stop-out therefore costs ≈ riskPerTradePct.
 */
export function positionSize({ capital, entry, stop, inst, leverage = 1, settings: s }) {
  const riskPerUnit = Math.abs(entry - stop);
  if (!(riskPerUnit > 0) || !(entry > 0)) return { qty: 0, reason: 'invalid stop distance' };
  const lev = inst.kind === 'futures' ? leverage : 1;
  const riskBudget = (capital * s.riskPerTradePct) / 100;
  const byRisk = riskBudget / riskPerUnit;
  const maxNotional = ((capital * s.maxPositionPct) / 100) * lev;
  const byNotional = maxNotional / entry;
  const qty = floorQty(inst, Math.min(byRisk, byNotional));
  if (!(qty > 0) || qty < inst.minQty) return { qty: 0, reason: `position too small (min qty ${inst.minQty}) for capital/risk settings` };
  const notional = qty * entry;
  if (notional < inst.minNotional) return { qty: 0, reason: `order value ${notional.toFixed(2)} below exchange minimum ${inst.minNotional} USDT` };
  return {
    qty,
    notional: +notional.toFixed(2),
    margin: +(notional / lev).toFixed(2),
    riskAmount: +(qty * riskPerUnit).toFixed(4),
    limitedBy: byRisk <= byNotional ? 'risk' : 'max position',
  };
}

/**
 * Futures: refuse trades whose stop sits too close to the liquidation price.
 * Isolated-margin liquidation is roughly 1/leverage away (minus maintenance margin),
 * so the stop must be well inside that or a fast move could liquidate before the stop fills.
 */
export function liquidationBlock({ entry, stop, leverage, maintenancePct = 0.5 }) {
  const liqDistPct = 100 / leverage - maintenancePct;
  const stopPct = (Math.abs(entry - stop) / entry) * 100;
  if (stopPct > liqDistPct * 0.6) return `stop ${stopPct.toFixed(2)}% away is too close to liquidation (~${liqDistPct.toFixed(1)}% at ${leverage}×) — lower the leverage`;
  return null;
}

/** Can we open another trade right now? Returns null if yes, else a reason. */
export function entryBlockReason({ day, openCount, hasPosition, cooling, capital, settings: s }) {
  if (hasPosition) return 'already in a position on this instrument';
  if (cooling) return 'cooling down after the last trade';
  if (openCount >= s.maxOpenPositions) return `max ${s.maxOpenPositions} open positions`;
  if (day.trades >= s.maxTradesPerDay) return `max ${s.maxTradesPerDay} trades per day reached`;
  const lossLimit = (capital * s.maxDailyLossPct) / 100;
  if (day.netPnl <= -lossLimit) return `daily loss limit ${lossLimit.toFixed(2)} USDT hit`;
  return null;
}
