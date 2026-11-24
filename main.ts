// Fresh-coin breakout bot for the Pump.fun Paper Sprint (agent-fun/replay/v2).
//
// Strategy in one paragraph: snipe the first minutes of a new bonding curve.
// A coin that is attracting buys within seconds of creation — price already a
// step above its creation price, with real SOL flowing in — gets a small
// fixed-size long, sold quickly into the early pump. Take profit is tight,
// losers are cut fast, and a hard time exit (minutes, not hours) keeps capital
// rotating across many coins, which is also what the 20-coin guardrail wants.
// Everything is deterministic: decisions come only from slots, reserves and fills.
//
// Price of a coin (lamports per token) = virtual_quote_reserves / virtual_token_reserves.
// Round-trip curve fees are ~1.25% per side, so exits are set well clear of them.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (simple, round numbers; chosen for robustness, not fitted) ----
const BUY_LAMPORTS = 100_000_000n; // 0.10 SOL per position: small stakes, many coins
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL: below this the tx fee eats the trade
const ENTRY_RISE_BPS = 500; // buy once price is +5% over first-seen price: early, not chased
const MAX_AGE_SLOTS = 600; // only coins first seen within ~4 min (600 slots): the opening pump
const MIN_TRADES = 2; // a little tape, but do not wait for the move to be over
const TAKE_PROFIT_BPS = 2000; // sell at +20% over average entry cost
const STOP_LOSS_BPS = 1000; // sell at -10% under average entry cost: cut losers fast
const MAX_HOLD_SLOTS = 900; // time exit after ~6 min, win or lose
const MAX_SLIPPAGE_BPS = 500; // 5% slippage tolerance on every order
const MIN_REAL_SOL = 2_000_000_000n; // 2 SOL of real reserves: enough that the size cap allows a real stake

interface Coin {
  firstPrice: number; // lamports per token at first sight
  firstSlot: number;
  lastPrice: number;
  lastSlot: number;
  trades: number;
  buySol: bigint; // SOL volume of buys seen
  sellSol: bigint; // SOL volume of sells seen
  realSol: bigint; // real SOL reserves at last sight (liquidity gauge)
  complete: boolean;
}

interface Held {
  entryCostPerToken: number; // lamports per token, fees included
  entrySlot: number;
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const lastSellSlot = new Map<string, number>();
// Mints with an order still in flight: never send a second order for the same
// mint while one is pending (the fill lands 2 slots later, and a duplicate
// would only come back rejected).
const pendingBuy = new Set<string>();
const pendingSell = new Set<string>();

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const now = batch.slot;

    // --- fold this batch's fills into entry bookkeeping ---
    for (const fill of batch.fills) {
      if (fill.side === 'buy') pendingBuy.delete(fill.mint);
      else pendingSell.delete(fill.mint);
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        const tokens = BigInt(fill.token_amount);
        const paid = BigInt(fill.quote_lamports);
        if (tokens > 0n) {
          held.set(fill.mint, {
            entryCostPerToken: Number(paid) / Number(tokens),
            entrySlot: fill.slot,
          });
        }
      } else {
        held.delete(fill.mint);
        lastSellSlot.set(fill.mint, fill.slot);
      }
    }

    // --- fold this batch's events into per-coin tape ---
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
        if (p > 0 && !coins.has(ev.mint)) {
          coins.set(ev.mint, {
            firstPrice: p, firstSlot: ev.slot, lastPrice: p, lastSlot: ev.slot,
            trades: 0, buySol: 0n, sellSol: 0n, realSol: 0n, complete: false,
          });
        }
      } else if (ev.event === 'TradeEvent') {
        const p = priceOf(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
        let c = coins.get(ev.mint);
        if (!c) {
          if (p <= 0) continue;
          c = {
            firstPrice: p, firstSlot: ev.slot, lastPrice: p, lastSlot: ev.slot,
            trades: 0, buySol: 0n, sellSol: 0n, realSol: BigInt(ev.real_sol_reserves), complete: false,
          };
          coins.set(ev.mint, c);
        }
        c.lastPrice = p;
        c.lastSlot = ev.slot;
        c.realSol = BigInt(ev.real_sol_reserves);
        c.trades += 1;
        if (ev.is_buy) c.buySol += BigInt(ev.sol_amount);
        else c.sellSol += BigInt(ev.sol_amount);
      } else {
        // CompleteEvent: the curve migrated; never trade it again.
        const c = coins.get(ev.mint);
        if (c) c.complete = true;
      }
    }

    // --- refresh last prices from marks (covers held coins with no trade this batch) ---
    for (const m of batch.marks) {
      const c = coins.get(m.mint);
      if (!c) continue;
      const p = priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
      if (p > 0 && m.slot >= c.lastSlot) {
        c.lastPrice = p;
        c.lastSlot = m.slot;
        c.realSol = BigInt(m.real_quote_reserves);
      }
    }

    // --- exits first: take profit, stop loss, time exit ---
    for (const [mint, pos] of state.positions) {
      const c = coins.get(mint);
      if (!c || c.complete) continue; // harness closes completed curves itself
      if (pendingSell.has(mint)) continue; // a sell is already in flight
      const h = held.get(mint);
      const entry = h ? h.entryCostPerToken : Number(pos.cost_lamports) / Number(pos.token_amount);
      const ratioBps = Math.floor(((c.lastPrice - entry) / entry) * 10000);
      const age = h ? now - h.entrySlot : 0;
      const takeProfit = ratioBps >= TAKE_PROFIT_BPS;
      const stopLoss = ratioBps <= -STOP_LOSS_BPS;
      const tooOld = h !== undefined && age >= MAX_HOLD_SLOTS;
      if (takeProfit || stopLoss || tooOld) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        pendingSell.add(mint);
      }
    }

    // --- entries: young coins breaking out on net buying ---
    const openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (openSlots > 0) {
      let buysSent = 0;
      for (const [mint, c] of coins) {
        if (buysSent >= openSlots) break;
        if (c.complete) continue;
        if (state.positions.has(mint)) continue;
        if (held.has(mint)) continue;
        if (pendingBuy.has(mint)) continue; // a buy is already in flight
        if (now - c.firstSlot > MAX_AGE_SLOTS) continue;
        if (c.trades < MIN_TRADES) continue;
        if (c.realSol < MIN_REAL_SOL) continue; // need real liquidity behind the curve
        if (now - c.lastSlot > 300) continue; // stale tape: do not chase an old print
        if (c.buySol <= c.sellSol) continue; // need net buying behind the move
        const riseBps = Math.floor(((c.lastPrice - c.firstPrice) / c.firstPrice) * 10000);
        if (riseBps < ENTRY_RISE_BPS) continue;
        // Skip coins we just sold (avoid churning the same coin).
        const lastSell = lastSellSlot.get(mint);
        if (lastSell !== undefined && now - lastSell < 600) continue;
        // Size: fixed stake, capped at 90% of the per-order reserve cap.
        const cap = state.maxBuyLamports(mint);
        let size = BUY_LAMPORTS;
        if (cap > 0n && cap < size) size = (cap * 9n) / 10n;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (size > state.freeCashLamports()) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        pendingBuy.add(mint);
        buysSent += 1;
      }
    }

    return orders;
  },
});
