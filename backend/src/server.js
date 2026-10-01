import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, LIVE_CONFIRM_PHRASE } from './config.js';
import { connectDb, col, closeDb, isMemoryDb } from './db.js';
import { RealClock, SimClock } from './lib/clock.js';
import { log, setLogClock } from './lib/bus.js';
import { MarketData, CoinDcxFeed } from './data/marketData.js';
import { SimFeed } from './data/simFeed.js';
import { InstrumentRegistry } from './data/instruments.js';
import { CoinDcxClient } from './broker/coindcxClient.js';
import { PaperBroker } from './broker/paperBroker.js';
import { LiveBroker } from './broker/liveBroker.js';
import { Engine } from './engine/engine.js';
import { loadSettings } from './engine/settings.js';
import { GeminiReviewer } from './ai/gemini.js';
import { authRouter, requireAuth } from './routes/auth.js';
import { apiRouter } from './routes/api.js';

await connectDb();
if (isMemoryDb()) log('warn', 'MONGO_URI=memory — trades, settings and paper-day counts are NOT saved across restarts');
const settings = await loadSettings();

let paperDaysDone = await countPaperDays();
async function countPaperDays() {
  return col('daily').countDocuments({ mode: 'paper', completed: true });
}

// ── decide the trading mode (live only when every safety gate passes) ──
const sim = config.dataSource === 'sim';
const client = sim ? null : new CoinDcxClient();
let mode = sim ? 'sim' : 'paper';
let modeBlockedReason = null;
if (config.mode === 'live') {
  if (sim) modeBlockedReason = 'TRADING_MODE=live ignored: DATA_SOURCE=sim is demo-only';
  else if (!config.liveConfirmed) modeBlockedReason = `TRADING_MODE=live ignored: set LIVE_TRADING_CONFIRM=${LIVE_CONFIRM_PHRASE} in .env`;
  else if (!client.hasKeys) modeBlockedReason = 'TRADING_MODE=live ignored: COINDCX_API_KEY / COINDCX_API_SECRET are not set';
  else if (paperDaysDone < config.minPaperDays) modeBlockedReason = `TRADING_MODE=live ignored: only ${paperDaysDone}/${config.minPaperDays} paper-trading days completed`;
  else mode = 'live';
}

const clock = sim ? new SimClock(config.simSpeed) : new RealClock();
setLogClock(clock);
const marketData = new MarketData(clock);
const feed = sim ? new SimFeed({ marketData }) : new CoinDcxFeed({ client, marketData });
const instruments = new InstrumentRegistry({ client });
const onOrder = (o) => {
  const { orderId, ...rest } = o;
  col('orders').updateOne({ _id: orderId }, { $set: { ...rest, mode, updatedAt: new Date() } }, { upsert: true }).catch(() => {});
};
const broker = mode === 'live' ? new LiveBroker({ client, onOrder }) : new PaperBroker({ marketData, slippageBps: settings.paperSlippageBps, onOrder });

let engine;
const reviewer = new GeminiReviewer({ getSettings: () => engine.settings });
engine = new Engine({
  clock,
  marketData,
  feed,
  broker,
  instruments,
  mode,
  requestedMode: config.mode,
  modeBlockedReason,
  settings,
  capitalDefault: config.capital,
  client,
  reviewer,
});
await engine.start();

setInterval(async () => {
  paperDaysDone = await countPaperDays().catch(() => paperDaysDone);
}, 60_000);

// ── HTTP ─────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 'loopback');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '200kb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, mode }));
app.use('/api/auth', authRouter);
app.use('/api', requireAuth, apiRouter({ engine, reviewer, client, paperDays: () => ({ done: paperDaysDone, required: config.minPaperDays }) }));

// Serve the built dashboard in production (frontend/dist)
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(config.port, () => console.log(`ZoopTrade Crypto API on http://localhost:${config.port} · mode=${mode}`));

async function shutdown(sig) {
  log('warn', `${sig} received — shutting down (exchange stop-losses stay active on open positions)`);
  engine.stop();
  server.close();
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
