# ZoopTrade Crypto: a 24×7 trading bot for CoinDCX (spot + futures)

ZoopTrade Crypto replaces the old Groww/NSE options bot. It trades crypto on **CoinDCX**, which is open 24 hours a day, 7 days a week. It works like this:

- It reads live prices from CoinDCX's public market data. **Paper trading needs no API keys.**
- It trades **USDT-margined perpetual futures** (long and short, low leverage), **USDT spot** (long only), or both.
- It runs a rule-based **trend-filtered channel breakout** strategy on closed candles (15-minute candles by default).
- It sizes every trade from a fixed risk budget and puts a **stop-loss on the exchange** for every live position.
- It takes profit at the target, moves the stop to breakeven at +1R and closes trades that go nowhere.
- A private dashboard shows everything live.

```
tradelele/
├── backend/    Node + Express + MongoDB   (trading engine, CoinDCX client, API)   → :4100
└── frontend/   React + Vite dashboard      (live desk, journal, settings)         → :5173
```

> ⚠️ **Read this first.** Most retail traders lose money in crypto, and leveraged futures can lose money very fast. No strategy, including this one, is guaranteed to make money. This bot enforces discipline: fixed risk, hard stops, low leverage, a daily loss limit and no revenge trading. It does not give you an edge the market hasn't already priced in. Run it in paper mode, judge it on 50+ trades, and only then decide whether to risk money you can afford to lose.

---

## 1. Quick start

**Requirements:** Node 18.18+ and, ideally, MongoDB (local, Docker `docker run -d -p 27017:27017 mongo:7`, or a free Atlas cluster).

```bash
# terminal 1 – backend
cd backend
cp .env.example .env        # defaults = paper trading on real CoinDCX prices
npm install
npm run dev

# terminal 2 – dashboard
cd frontend
npm install
npm run dev                 # open http://localhost:5173 and sign in with DASHBOARD_PASSWORD
```

**No MongoDB yet?** Set `MONGO_URI=memory`. Everything works, but the journal, settings and paper-day count are lost when the bot restarts.

**Just want to see it move?** Set `DATA_SOURCE=sim`. The bot then runs on synthetic prices at 10× speed (a 15-minute candle every 90 seconds). Simulated results are random and tell you **nothing** about the strategy.

**Production (one process):** set `NODE_ENV=production` in `.env`, run `npm run build` in `frontend/`, then `npm start` in `backend/`. The backend serves the built dashboard at `http://your-server:4100`.

---

## 2. Why the switch from Groww to CoinDCX

| | Old bot (Groww, NSE options) | New bot (CoinDCX, crypto) |
|---|---|---|
| Market hours | 09:15–15:30 IST, weekdays, minus holidays | 24×7 |
| Strategy window | One opening range per day, entries until 11:30 | A fresh signal check on every candle close |
| Daily login | Access token expires every morning | API key + secret; requests are signed, nothing expires daily |
| Paper trading | Needed Groww API access for prices | Public prices, **no keys needed** |
| Shorting | Buy puts only | Futures shorts |
| Static IP / SEBI algo rules | Required | Not required (binding your API key to an IP is still a good idea) |

---

## 3. CoinDCX API keys (live trading only)

1. On CoinDCX go to **Settings → API Dashboard** and create a key.
2. **Enable trading. Never enable withdrawals.** If CoinDCX lets you bind the key to an IP address, bind it to your server's IP.
3. Put the key and secret in `backend/.env`: `COINDCX_API_KEY`, `COINDCX_API_SECRET`.
4. For futures, move some USDT into your **futures wallet** in the CoinDCX app. For spot, keep USDT in your spot wallet.

How the bot authenticates: every private request is a POST whose JSON body includes a `timestamp` (milliseconds). The exact body string is signed with HMAC-SHA256 using your secret and sent in the `X-AUTH-APIKEY` and `X-AUTH-SIGNATURE` headers.

---

## 4. The strategy: trend-filtered channel breakout

A 24×7 market has no "opening range", so the bot uses a classic **Donchian channel breakout**. It looks at every candle close, filters by trend and volatility, and exits by R-multiples.

| Step | Rule (all configurable on the **Strategy & risk** page) |
|---|---|
| Universe | Futures: `B-BTC_USDT`, `B-ETH_USDT`, `B-SOL_USDT`, `B-XRP_USDT`. Spot: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `XRPUSDT` |
| Candles | **15-minute** candles (5 / 15 / 30 / 60 available), fetched from CoinDCX right after each close |
| Channel | Highest high / lowest low of the previous **20** candles |
| Long entry | A candle **closes** above the channel high + 0.05%, and the close is **above EMA 50** |
| Short entry (futures only) | A candle **closes** below the channel low − 0.05%, and the close is **below EMA 50** |
| Volatility filter | Skip if ATR(14) is under **0.15%** of price (dead market) or over **3%** (stop too wide) |
| Stop-loss | **1.5 × ATR** from entry, capped at **3%**. Placed **on the exchange** |
| Target | **2 × risk** (2R) |
| Breakeven | At +1R the stop moves to entry **plus round-trip fees**, so a winner can't turn into a loss |
| Optional trail | After breakeven, trail the stop N × ATR behind each candle close (off by default) |
| Time stop | Close trades that are still open after **48 h** |
| Cooldown | After a trade, wait **4 candles** before trading the same coin again (prevents revenge trading) |

**Why candle closes and not ticks?** A single tick through the channel is often a wick that reverses. Waiting for the candle to close filters out many false breakouts.

**Why the EMA filter?** Breakouts against the trend fail more often. Only trades in the direction of the trend are taken.

### Risk management (this matters more than the entry rules)

| Guard | Default |
|---|---|
| Risk per trade | **1%** of capital. Qty = (capital × 1%) ÷ (entry − stop), rounded down to the exchange's quantity step |
| Max margin per trade | 50% of capital. Futures notional = margin × leverage |
| Leverage | **3×** (max 10× allowed in settings). The bot refuses any trade whose stop is too close to the liquidation price |
| Max open positions | 2 |
| Max trades per day | 6 per IST day |
| Daily loss limit | **4%** of capital (realized + open). The bot closes everything and stops opening trades until midnight IST |

With 100 USDT and 3× leverage, a stopped-out trade loses about 1 USDT plus fees, and the worst day is capped at about 4 USDT.

### Fees and taxes are included

Every trade's P&L is **net of estimated CoinDCX fees plus 18% GST** on the fees. The defaults are 0.2% per side for spot and 0.05% taker per side for futures. **Check your own fee tier on CoinDCX and set it in Strategy & risk.**

- **TDS (India):** 1% TDS is withheld on spot sells. The bot records it on each spot trade and shows it separately. It isn't subtracted from P&L, because you can claim it in your tax return, but it does tie up cash.
- **Funding:** perpetual futures pay or receive funding every few hours. The bot doesn't model this; on 15-minute trades it's usually small.
- **Tax:** crypto gains in India are taxed at a flat 30% and losses can't be set off. Talk to a tax professional.

---

## 5. Paper trading → live (the safety gates)

| Mode | What happens |
|---|---|
| `DATA_SOURCE=sim` | Synthetic prices, simulated fills. For trying out the UI. |
| `TRADING_MODE=paper` (default) | **Real CoinDCX prices, simulated fills** with 5 bps slippage. Nothing is sent to your account. |
| `TRADING_MODE=live` | Real orders on your CoinDCX account. |

Setting `TRADING_MODE=live` is **refused** (the bot stays in paper and shows a warning banner) unless all of these are true:

1. `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK` is set in `.env`.
2. `COINDCX_API_KEY` and `COINDCX_API_SECRET` are set.
3. At least `MIN_PAPER_DAYS` (default **7**) paper days are complete. A day counts once the bot ran for at least 20 hours of that IST day.
4. `DATA_SOURCE=coindcx`.

The mode can only be changed in `.env`. The dashboard cannot switch it.

**My advice:** 7 days of 24×7 trading is roughly 15–40 trades. That's enough to confirm the *plumbing* works, but not to prove the *strategy*. If you go live, start small (for example 50–100 USDT) and low leverage (2–3×) until you have 50+ trades and a positive expectancy (R) after fees.

---

## 6. Dashboard

- **Live desk**
  - Net P&L after fees in USDT, with the ₹ equivalent (live USDT/INR rate).
  - Open positions with entry, stop, target, leverage and live P&L.
  - Candle chart with the channel, EMA, entry, stop and target lines.
  - Breakout scanner: every coin's channel, ATR, trend and status.
  - Live decision log explaining every entry, skip and exit.
  - API usage and when the next candle check happens.
- **Controls:** **Pause** (no new entries; open trades still managed), **Kill switch** (close everything at market and pause), and a close button on each position.
- **Journal:** equity curve, win rate, profit factor, expectancy in R, max drawdown, fees, long vs short P&L, and every trade. Switch between paper, live and sim.
- **Strategy & risk:** edit every parameter, coin list, leverage and fee rate. Changes are saved in MongoDB and apply on the next candle check. Open positions keep being managed.
- **AI review:** optional Gemini journal (see below).

The dashboard is password-protected (`DASHBOARD_PASSWORD`). If you expose it to the internet, put it behind HTTPS (Caddy or Nginx) and use a strong password.

---

## 7. Gemini: used only where it actually helps

An LLM **never** places, sizes or blocks a trade here, for three reasons:

- It takes seconds to respond, and breakouts move faster than that.
- It gives different answers to the same input, so you can't backtest it.
- It can hallucinate, and here that would cost real money.

What it *is* good at is reading the day's trades and writing the trading journal you'd otherwise skip. With `GEMINI_API_KEY` set, just after midnight IST it reviews the previous day's trades, execution problems and patterns across recent days. It also warns against changing parameters on small samples. It is optional and off by default.

---

## 8. Safety design

- **Exchange stop-loss:**
  - **Futures:** a stop-market order is attached to the position (`positions/create_tpsl`). If the bot crashes or your internet drops, the stop still protects you. The bot checks it every 5 seconds and re-places it if it disappears.
  - **Spot:** a `stop_limit` sell, with the limit 0.5% below the trigger so it still fills in a fast fall. On markets where CoinDCX doesn't offer stop-limit orders, the bot watches the stop itself and the dashboard warns you.
- **No double exits:**
  - **Spot:** before a target, time or manual exit, the bot cancels the exchange stop and confirms the cancellation. Only then does it send the market sell.
  - **Futures:** the bot exits the whole position, and the attached stop goes with it.
- **Liquidation guard:** a futures trade is refused if its stop is more than 60% of the way to the estimated liquidation price.
- **Restart recovery:** open trades are stored in MongoDB and picked up again after a restart. In paper mode the simulated stops are re-created.
- **Kill switch:** on the dashboard.
- **Order placement is never retried blindly**, to avoid duplicate orders. On an HTTP 429 the bot backs off automatically.

### Running it 24×7

The bot never sleeps, so run it on a VPS or an always-on machine:

```bash
npm i -g pm2
cd backend && pm2 start "npm start" --name zooptrade-crypto && pm2 save && pm2 startup
```

On Windows, use [NSSM](https://nssm.cc) as before:

```powershell
nssm install ZoopTradeCrypto "C:\Program Files\nodejs\node.exe" "C:\zooptrade\backend\src\server.js"
nssm set ZoopTradeCrypto AppDirectory C:\zooptrade\backend
```

Since crypto never closes, also stop Windows Update from rebooting the machine: pause updates or set the active hours. Keep the clock accurate with `w32tm /resync` (on Linux, chrony or systemd-timesyncd). Candle timing depends on it.

---

## 9. Tests

```bash
cd backend && npm test
```

The tests cover:

- Indicators (EMA, ATR), breakout signals, the trend and volatility filters, stops and targets, and the breakeven and ATR trail.
- Position sizing, quantity and tick rounding, the liquidation guard and the daily guards.
- Fees, GST and TDS, settings validation, the rate limiter, the paper broker and the request signature.
- An **end-to-end live-order test against a mock CoinDCX server**, for both futures and spot. Every request's HMAC signature is verified. Futures: leverage → entry → exchange stop → breakeven → target exit. Spot: buy → stop-limit → cancel-and-re-place at breakeven → cancel stop → sell.

No MongoDB is needed for the tests.

### Before going live, verify these in paper mode

The CoinDCX request and response fields come from CoinDCX's public API documentation and two community SDKs. I couldn't test them against a real CoinDCX account. Confirm these:

- Prices load for all your coins (the **Data & API** panel shows any errors).
- Candles load. The scanner shows a channel and ATR for every coin within a minute of starting.
- The log does **not** say "could not load … rules". If it does, check that the symbol or pair exists on CoinDCX.
- **Then make a tiny live test** (for example `CAPITAL=20`, 2× leverage, a single coin). Check in the CoinDCX app that the stop-loss appears on the position, and that a manual close from the dashboard really closes it.
