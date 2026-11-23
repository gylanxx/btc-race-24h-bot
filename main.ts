// Trend rider for cbBTC/USDC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Idea: ride multi-hour uptrends, sit in cash otherwise. A round trip costs
// ~46 bps at full size (4 bps fee + 2 bps slippage + ~17 bps of pool impact
// each way at this depth), so the bot only trades when the trend is real and
// never chases 1-minute noise:
//
//   - Entry: EMA(24) above EMA(96) by more than 40 bps. The 40 bps
//     confirmation keeps dead-cat bounces in a downtrend from triggering a
//     full-size buy; a plain zero cross fires on every bounce.
//   - Exit: a 2% trailing stop below the highest close since entry, the
//     EMA gap falling under -100 bps, or a 2% hard stop against cost.
//     Whichever fires first sells the whole position.
//   - Cooldown: 60 bars after an exit before the next entry, so a whipsaw
//     cannot churn the account.
//   - Probe: if the window has produced no trade by bar 1200, buy 10% of
//     cash on the next close above the previous 10 bars' high. This only
//     exists so a flat/down window still meets the "at least 1 trade"
//     guardrail; it costs at most a couple of dollars when it fires.
//
// Everything is deterministic: float64 EMAs seeded from the closes, no clock,
// no network, no randomness. The same bars always give the same orders.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 24;
const SLOW_SPAN = 96;
/** Entry needs the fast EMA this far above the slow one, in bps. */
const ENTRY_GAP_BPS = 40;
/** Exit when the fast/slow gap falls under this, in bps. */
const EXIT_GAP_BPS = -100;
/** Trailing stop: sell once the close is this far under the peak since entry, in bps. */
const TRAIL_BPS = 200;
/** Hard stop: sell once the position is worth this far under its cost, in bps. */
const STOP_BPS = 200;
/** Bars to wait after an exit before re-entering. */
const COOLDOWN_BARS = 60;
/** The probe fires no earlier than this batch. */
const PROBE_BAR = 1200;
/** The probe buys this share of cash, in percent. */
const PROBE_PCT = 10;
/** Orders refuse a fill more than this past the latest close, in bps. */
const MAX_SLIPPAGE_BPS = 100;

/** One EMA over closes: seeded as the mean of its first span, then the usual 2/(span+1) step. */
class Ema {
  readonly span: number;
  private warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  step(close: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
  }
}

const fast = new Ema(FAST_SPAN);
const slow = new Ema(SLOW_SPAN);
/** Closes of the bars before the one being answered. */
const prevCloses: bigint[] = [];
/** Highest close since the current entry (0 when flat). */
let peak = 0n;
/** First batch an entry may be sent on (after a sell). */
let cooldownUntil = -1;
/** Whether any buy has been sent yet this run. */
let traded = false;
/** Whether the late probe has fired. */
let probeDone = false;

/** The gap between the EMAs in bps, once both are seeded. */
function gapBps(): number | null {
  if (fast.value === null || slow.value === null || slow.value === 0) return null;
  return ((fast.value - slow.value) / slow.value) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Only the batch that actually carries a CBBTC bar moves the indicators;
    // a minute the recorder missed adds nothing.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);

    fast.step(Number(bar.c));
    slow.step(Number(bar.c));
    const gap = gapBps();
    if (state.warmingUp || gap === null) {
      prevCloses.push(close);
      return [];
    }

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      if (close > peak) peak = close;
      const value = state.value(SYMBOL, held.qty);
      const trailHit = close * 10000n < peak * BigInt(10000 - TRAIL_BPS);
      const gapHit = gap < EXIT_GAP_BPS;
      const stopHit = value * 10000n < held.cost * BigInt(10000 - STOP_BPS);
      if (trailHit || gapHit || stopHit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cooldownUntil = batch.seq + COOLDOWN_BARS;
        peak = 0n;
      }
    } else if (batch.seq >= cooldownUntil) {
      if (gap > ENTRY_GAP_BPS) {
        const room = state.weightRoom(SYMBOL);
        const notional = state.cash < room ? state.cash : room;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          peak = close;
          traded = true;
        }
      } else if (!traded && !probeDone && batch.seq >= PROBE_BAR && prevCloses.length >= 10) {
        const recentHigh = prevCloses.slice(-10).reduce((a, x) => (x > a ? x : a), 0n);
        if (close > recentHigh) {
          const notional = state.cash / 100n * BigInt(PROBE_PCT);
          if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
            orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
            peak = close;
            traded = true;
            probeDone = true;
          }
        }
      }
    }

    prevCloses.push(close);
    return orders;
  },
});
