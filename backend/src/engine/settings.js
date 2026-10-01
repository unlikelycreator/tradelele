import { z } from 'zod';
import { DEFAULT_SETTINGS } from '../config.js';
import { col } from '../db.js';

const spotSymbol = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,15}USDT$/, 'spot symbols look like BTCUSDT (USDT markets only)');
const futuresPair = z.string().trim().toUpperCase().regex(/^[A-Z]-[A-Z0-9]{2,15}_USDT$/, 'futures pairs look like B-BTC_USDT');

export const settingsSchema = z.object({
  market: z.enum(['futures', 'spot', 'both']),
  spotSymbols: z.array(spotSymbol).max(30),
  futuresPairs: z.array(futuresPair).max(30),
  futures: z.object({
    leverage: z.number().int().min(1).max(10),
    marginType: z.enum(['isolated']),
    allowShorts: z.boolean(),
  }),
  timeframe: z.union([z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
  channelBars: z.number().int().min(5).max(100),
  emaPeriod: z.number().int().min(5).max(250),
  useTrendFilter: z.boolean(),
  atrPeriod: z.number().int().min(5).max(50),
  breakoutBufferPct: z.number().min(0).max(1),
  minAtrPct: z.number().min(0).max(5),
  maxAtrPct: z.number().min(0.1).max(20),
  stopAtr: z.number().min(0.5).max(5),
  maxStopPct: z.number().min(0.2).max(10),
  rewardRisk: z.number().min(0.5).max(6),
  trailToBreakevenAtR: z.number().min(0).max(5),
  trailAtr: z.number().min(0).max(6),
  maxHoldHours: z.number().min(0).max(24 * 14),
  cooldownBars: z.number().int().min(0).max(100),
  capital: z.number().positive().nullable(),
  riskPerTradePct: z.number().min(0.1).max(5),
  maxPositionPct: z.number().min(1).max(100),
  maxOpenPositions: z.number().int().min(1).max(10),
  maxTradesPerDay: z.number().int().min(1).max(50),
  maxDailyLossPct: z.number().min(0.5).max(25),
  paperSlippageBps: z.number().min(0).max(100),
  fees: z.object({
    spotPct: z.number().min(0).max(2),
    futuresTakerPct: z.number().min(0).max(1),
    gstPct: z.number().min(0).max(30),
    tdsPct: z.number().min(0).max(5),
  }),
});

export function mergeSettings(saved = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    futures: { ...DEFAULT_SETTINGS.futures, ...(saved.futures || {}) },
    fees: { ...DEFAULT_SETTINGS.fees, ...(saved.fees || {}) },
  };
}

export async function loadSettings() {
  const doc = await col('settings').findOne({ _id: 'strategy' });
  const { _id, updatedAt, ...saved } = doc || {};
  return mergeSettings(saved);
}

export function validateSettings(patch, current) {
  const next = settingsSchema.parse({
    ...current,
    ...patch,
    futures: { ...current.futures, ...(patch.futures || {}) },
    fees: { ...current.fees, ...(patch.fees || {}) },
  });
  next.spotSymbols = [...new Set(next.spotSymbols)];
  next.futuresPairs = [...new Set(next.futuresPairs)];
  if (next.minAtrPct >= next.maxAtrPct) throw new Error('minAtrPct must be below maxAtrPct');
  if (next.market !== 'futures' && !next.spotSymbols.length) throw new Error('add at least one spot symbol');
  if (next.market !== 'spot' && !next.futuresPairs.length) throw new Error('add at least one futures pair');
  return next;
}

export async function saveSettings(patch, current) {
  const next = validateSettings(patch, current);
  await col('settings').updateOne({ _id: 'strategy' }, { $set: { ...next, updatedAt: new Date() } }, { upsert: true });
  return next;
}
