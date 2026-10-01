import 'dotenv/config';
import { z } from 'zod';

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

const schema = z.object({
  PORT: z.coerce.number().default(4100),
  NODE_ENV: z.string().default('development'),
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017'),
  MONGO_DB: z.string().default('zooptrade_crypto'),
  DASHBOARD_PASSWORD: z.string().default(''),
  JWT_SECRET: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  LIVE_TRADING_CONFIRM: z.string().default(''),
  MIN_PAPER_DAYS: z.coerce.number().int().min(0).default(7),
  DATA_SOURCE: z.enum(['coindcx', 'sim']).default('coindcx'),
  SIM_SPEED: z.coerce.number().min(1).max(120).default(10),
  COINDCX_API_KEY: z.string().default(''),
  COINDCX_API_SECRET: z.string().default(''),
  COINDCX_API_URL: z.string().default('https://api.coindcx.com'),
  COINDCX_PUBLIC_URL: z.string().default('https://public.coindcx.com'),
  CAPITAL: z.coerce.number().positive().default(100),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
});

const env = schema.parse(process.env);
const isProd = env.NODE_ENV === 'production';

if (isProd && (!env.JWT_SECRET || !env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD === 'change-me')) {
  throw new Error('Set DASHBOARD_PASSWORD and JWT_SECRET in .env before running in production.');
}

export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_REAL_MONEY_IS_AT_RISK';

export const config = {
  port: env.PORT,
  isProd,
  mongoUri: env.MONGO_URI,
  mongoDb: env.MONGO_DB,
  dashboardPassword: env.DASHBOARD_PASSWORD || 'change-me',
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  corsOrigins: csv(env.CORS_ORIGIN),
  mode: env.TRADING_MODE,
  liveConfirmed: env.LIVE_TRADING_CONFIRM === LIVE_CONFIRM_PHRASE,
  minPaperDays: env.MIN_PAPER_DAYS,
  dataSource: env.DATA_SOURCE,
  simSpeed: env.SIM_SPEED,
  coindcx: {
    apiKey: env.COINDCX_API_KEY,
    apiSecret: env.COINDCX_API_SECRET,
    apiUrl: env.COINDCX_API_URL.replace(/\/$/, ''),
    publicUrl: env.COINDCX_PUBLIC_URL.replace(/\/$/, ''),
  },
  capital: env.CAPITAL,
  gemini: { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL },
};

/**
 * Strategy + risk defaults. Overridable from the dashboard (persisted in Mongo).
 * All money values are in USDT.
 */
export const DEFAULT_SETTINGS = {
  // What to trade: 'futures' = USDT-margined perpetuals (long + short), 'spot' = USDT spot (long only), 'both'
  market: 'futures',
  // CoinDCX spot markets (USDT quoted). Liquid majors: tight spreads, reliable candles.
  spotSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  // CoinDCX futures pairs (USDT-margined perpetuals)
  futuresPairs: ['B-BTC_USDT', 'B-ETH_USDT', 'B-SOL_USDT', 'B-XRP_USDT'],
  futures: {
    leverage: 3, // keep it low: the stop should hit long before liquidation
    marginType: 'isolated',
    allowShorts: true,
  },
  // ── Trend-filtered channel breakout ──
  timeframe: 15, // candle size in minutes (5, 15, 30 or 60)
  channelBars: 20, // breakout of the high/low of the previous N candles (Donchian)
  emaPeriod: 50, // trend filter: longs only above the EMA, shorts only below
  useTrendFilter: true,
  atrPeriod: 14,
  breakoutBufferPct: 0.05, // candle must close this % beyond the channel
  minAtrPct: 0.15, // skip dead markets (ATR below this % of price)
  maxAtrPct: 3, // skip chaotic markets (stop would be too wide)
  stopAtr: 1.5, // stop = entry ∓ 1.5 × ATR …
  maxStopPct: 3, // … but never more than 3% from entry
  rewardRisk: 2, // target = entry ± 2R
  trailToBreakevenAtR: 1, // move the stop to breakeven (+ fees) after +1R
  trailAtr: 0, // after breakeven, trail the stop this many ATRs behind the close (0 = off)
  maxHoldHours: 48, // time stop: close trades that go nowhere
  cooldownBars: 4, // after closing a trade, wait this many candles before re-entering that coin
  // ── risk (USDT; sized for a small ~100 USDT account) ──
  capital: null, // null → CAPITAL from .env
  riskPerTradePct: 1, // loss if the stop is hit, % of capital (plus fees/slippage)
  maxPositionPct: 50, // max margin per trade, % of capital (futures notional = margin × leverage)
  maxOpenPositions: 2,
  maxTradesPerDay: 6, // IST calendar day
  maxDailyLossPct: 4, // the bot stops opening trades for the rest of the IST day beyond this loss
  paperSlippageBps: 5, // simulated slippage on paper market fills (0.05%)
  // CoinDCX fees (check your tier on coindcx.com/fees). GST is charged on top of fees in India.
  fees: {
    spotPct: 0.2, // per side
    futuresTakerPct: 0.05, // per side (the bot uses market orders → taker)
    gstPct: 18,
    tdsPct: 1, // TDS withheld on spot sells (Sec. 194S) — shown separately, claimable in your return
  },
};
