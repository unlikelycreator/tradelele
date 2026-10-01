// IST helpers. Crypto trades 24×7; the IST calendar day is only used for daily
// accounting (trade count, daily loss limit, journal). India has no DST, so a fixed
// +05:30 offset is exact.
const IST_OFFSET_MS = 330 * 60 * 1000;

/** Wall-clock parts of `date` in IST. */
export function istParts(date = new Date()) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0 = Sunday
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD in IST. */
export function istDate(date = new Date()) {
  const p = istParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Start (epoch ms) of the candle of `tfMinutes` that contains `ms`. Candles align to UTC. */
export function barStart(ms, tfMinutes) {
  const step = tfMinutes * 60_000;
  return Math.floor(ms / step) * step;
}
