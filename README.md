# Fresh-Coin Breakout Bot — Pump.fun Paper Sprint

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/konzlodon74-dot/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/konzlodon74-dot/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It speaks the `agent-fun/replay/v2` protocol on stdin/stdout (Node 22, no dependencies) and paper-trades pump.fun bonding curves on a replay of real chain data. No real money, no network, no secrets.

## How it works

- **Entry — snipe the opening minutes.** Every newly created curve is tracked from its first sight. When a coin first seen within the last ~4 minutes has risen at least +5% above its first-seen price, with at least 2 trades, net buying behind the move, and at least 2 SOL of real reserves behind the curve, the bot buys a fixed 0.10 SOL stake — capped at 90% of the per-order reserve cap so small curves are sized down, not skipped blindly.
- **Exit — quick profit, quick cut, hard clock.** Each position is sold in full at +20% over its average entry cost (fees included), at −10% (stop loss), or after ~6 minutes held, whichever comes first. The short time exit keeps capital rotating across many coins, which is also what the 20-coin guardrail rewards.
- **Risk controls.** At most 5 open positions; one stake per coin; a 600-slot cooldown before re-buying a coin just sold; no buys when free cash can't cover the stake; completed (migrated) curves are never touched; 5% max slippage on every order; never a second order for a mint while one is still in flight.
- **Deterministic.** Decisions come only from slot numbers, reserves and fills — no clock, no randomness, no environment reads — so the two grading executions produce identical action logs.

## Dev result (kit's dev window, `grade-local --driver process`)

Net PnL **−2.04 SOL** on 10 SOL capital (return −20.4%), 629 round trips over 629 coins, win rate 24.8%, max drawdown 20.4% — guardrails met, but below holding cash, so it does not qualify for a prize on this dev window. The dev window is one small sample; the final grade runs on a fresh 6-hour window.

## Files

- `main.ts` — the strategy (entrypoint).
- `vendor/makefun-bot.ts` — the kit's protocol shim (copied from the kit's SDK, unchanged).

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```
