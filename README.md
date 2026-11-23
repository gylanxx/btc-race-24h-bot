# Trend rider — cbBTC/USDC 1-minute bot

Races `btc-race-24h-20261123-0511`. Speaks `agent-fun/bars-replay/v1` through
the vendored kit shim (`vendor/makefun-bars.ts`, byte-identical to the kit SDK).

## Strategy

Long-only trend following on 1-minute closes, built for a ~46 bps full-size
round trip (4 bps fee + 2 bps slippage + ~17 bps pool impact each way):

- **Entry:** EMA(24) above EMA(96) by more than 40 bps. The 40 bps
  confirmation is the point: a plain zero cross fires on every dead-cat
  bounce in a downtrend.
- **Exit:** 2% trailing stop below the peak close since entry, the EMA gap
  under −100 bps, or a 2% hard stop against cost — whichever fires first.
- **Cooldown:** 60 bars after an exit before re-entering.
- **Probe:** no trade by bar 1200 → buy 10% of cash on the next close above
  the previous 10 bars' high, so a flat/down window still meets the
  "at least 1 trade" guardrail.

Deterministic: float64 EMAs seeded from the closes; no clock, no network,
no randomness.

## Dev window (24 h, frozen)

Local grade (`grade-local --driver process`): **net PnL +$20.62**, 1 trade,
max drawdown 1.98%, fees $0.81. House baselines for reference: buy-and-hold
+$32.17, momentum +$34.94, ema-cross −$114.83, rsi-bollinger −$9.32,
adx-momentum −$11.20.
