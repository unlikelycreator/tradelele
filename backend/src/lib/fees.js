/**
 * Estimated CoinDCX trading costs for one round trip (entry + exit), in the quote currency.
 *  - fee  = traded value × fee rate on each side, plus GST on the fee (India)
 *  - tds  = 1% TDS withheld on spot sells (Sec. 194S). It is a tax credit, not a cost, so it is
 *           reported separately and NOT subtracted from net P&L — but it does tie up cash.
 * Rates live in settings.fees so you can match your CoinDCX fee tier.
 */
export function roundTripFees({ kind, entryValue, exitValue, fees }) {
  const rate = (kind === 'futures' ? fees.futuresTakerPct : fees.spotPct) / 100;
  const base = (entryValue + exitValue) * rate;
  const total = base * (1 + fees.gstPct / 100);
  return round4(total);
}

/** TDS on the spot sell side (long-only spot → the exit). */
export function spotTds({ kind, exitValue, fees }) {
  return kind === 'spot' ? round4((exitValue * fees.tdsPct) / 100) : 0;
}

/** Fee + GST as a % of price for one round trip — used to make a "breakeven" stop actually breakeven. */
export function roundTripCostPct(kind, fees) {
  const rate = kind === 'futures' ? fees.futuresTakerPct : fees.spotPct;
  return 2 * rate * (1 + fees.gstPct / 100);
}

export const round4 = (x) => Math.round(x * 1e4) / 1e4;
