// Quick build (beta): the limits, in the counter store the demo tutor uses (lib/demo/tutor-store.ts; Upstash on Vercel,
// and a store that is down or missing there means no call at all). Only numbers are stored, under hashed ids.
//
//   per visitor (signed cookie, advisory): 15 questions a day, 6 batches a minute
//   per IP: batches by the minute, questions by the day
//   global, Quick build's OWN: $4 a day and 1,500 model calls a day, reserved before every call and settled after
//
// Quick build shares the demo key (REWIND_DEMO_ANTHROPIC_API_KEY, $30 monthly Console limit) with the live tutor, but never its
// allowance: every counter here is under rw:quick:, the tutor's under rw:tutor:, so neither can use up the other's.
// Quick's $4 plus the tutor's $3 a day stay under the key's $30 (a test holds them to it).

import { dayKey, LIMITS as TUTOR } from "../demo/tutor-limits.ts";
import type { CounterStore } from "../demo/tutor-store.ts";
import { LIMITS as REQUEST } from "./types.ts";

/**
 * The demo key's Console limit, in millionths of a dollar: $30 monthly; at full use, $4 + $3 = $7 a day, about 4 days.
 * Then the key stops, the tutor answers with saved replies and Quick build fails.
 */
export const KEY_LIMIT_MICRO_USD = 30_000_000;

export const QUICK_LIMITS = {
  visitorBatchesPerMinute: 6,
  ipBatchesPerMinute: 12,
  visitorQuestionsPerDay: REQUEST.questionsPerDay,
  ipQuestionsPerDay: 60,
  /** Quick build's own estimated spend per day across everyone, in millionths of a dollar: $8 (John, Sun 16:0x, raised
   *  from $4 for judging day; the key's $30 monthly limit still caps it). */
  dayMicroUsd: 8_000_000,
  /** Quick build's own model calls per day across everyone (each question takes a few: the draft, retries, the check). */
  dayCalls: 3_000,
} as const;

/** Quick's and the tutor's daily dollars together, which must stay under the key's limit. */
export const SHARED_KEY_DAY_MICRO_USD = QUICK_LIMITS.dayMicroUsd + TUTOR.dayMicroUsd;

export type QuickRefusal = "rate" | "visitor" | "ip-day" | "day-budget";

const DAY = 2 * 86_400;

/**
 * Counts one batch of up to `want` questions. Returns how many may be written (0 to want) or the refusal. The per-minute
 * counters keep their count when they refuse (hammering still trips them); the question counters give back what isn't
 * granted, so the visitor's 15 a day holds across batches to the question.
 */
export async function reserveBatch(store: CounterStore, o: { visitor: string; ip: string; want: number; now: number }): Promise<{ granted: number } | { refused: QuickRefusal }> {
  const day = dayKey(o.now);
  const minute = Math.floor(o.now / 60_000);
  const ops = [
    { key: `rw:quick:ipm:${o.ip}:${minute}`, n: 1, ttlSec: 120 },
    { key: `rw:quick:vbm:${o.visitor}:${minute}`, n: 1, ttlSec: 120 },
    { key: `rw:quick:vq:${o.visitor}:${day}`, n: o.want, ttlSec: DAY },
    { key: `rw:quick:ipq:${o.ip}:${day}`, n: o.want, ttlSec: DAY },
  ];
  const [ipm, vbm, vq, ipq] = await store.incrMany(ops);
  const give = (n: number, from: number[]) =>
    n > 0 ? store.incrMany(from.map((i) => ({ key: ops[i].key, n: -n, ttlSec: ops[i].ttlSec }))).catch(() => {}) : Promise.resolve();
  if (ipm > QUICK_LIMITS.ipBatchesPerMinute || vbm > QUICK_LIMITS.visitorBatchesPerMinute) {
    await give(o.want, [2, 3]);
    return { refused: "rate" };
  }
  const visitorLeft = Math.max(0, QUICK_LIMITS.visitorQuestionsPerDay - (vq - o.want));
  const ipLeft = Math.max(0, QUICK_LIMITS.ipQuestionsPerDay - (ipq - o.want));
  const granted = Math.min(o.want, visitorLeft, ipLeft);
  // Give back what was counted but not granted, on each counter.
  await give(o.want - granted, [2, 3]);
  if (granted > 0) return { granted };
  return { refused: visitorLeft === 0 ? "visitor" : "ip-day" };
}

/** After the batch: the questions that were counted but not written. */
export async function giveBack(store: CounterStore, o: { visitor: string; ip: string; n: number; now: number }): Promise<void> {
  if (o.n <= 0) return;
  const day = dayKey(o.now);
  await store
    .incrMany([
      { key: `rw:quick:vq:${o.visitor}:${day}`, n: -o.n, ttlSec: DAY },
      { key: `rw:quick:ipq:${o.ip}:${day}`, n: -o.n, ttlSec: DAY },
    ])
    .catch(() => {});
}

/** Raised when the day's dollars are spent: no more calls in this batch. */
export class BudgetStop extends Error {
  constructor() {
    super("day budget spent");
    this.name = "BudgetStop";
  }
}

/** Quick build's own day counters: dollars and model calls. Never the tutor's (rw:tutor:micro, rw:tutor:calls). */
export const microKey = (now: number) => `rw:quick:micro:${dayKey(now)}`;
export const callsKey = (now: number) => `rw:quick:calls:${dayKey(now)}`;

/**
 * Reserves one call against Quick build's own day: its worst-case cost against the $4, and one of the 1,500 calls (one
 * round trip). Throws BudgetStop (after giving both back) when either would pass. A store that fails throws StoreDown.
 */
export async function reserveCall(store: CounterStore, estimateMicro: number, now: number): Promise<void> {
  const ops = [
    { key: microKey(now), n: estimateMicro, ttlSec: DAY },
    { key: callsKey(now), n: 1, ttlSec: DAY },
  ];
  const [micro, calls] = await store.incrMany(ops);
  if (micro > QUICK_LIMITS.dayMicroUsd || calls > QUICK_LIMITS.dayCalls) {
    await store.incrMany(ops.map((o) => ({ ...o, n: -o.n }))).catch(() => {});
    throw new BudgetStop();
  }
}

/** Replaces the reserved estimate with what the call really cost. */
export async function settleCall(store: CounterStore, o: { estimateMicro: number; actualMicro: number; now: number }): Promise<void> {
  const delta = Math.round(o.actualMicro - o.estimateMicro);
  if (delta) await store.incrBy(microKey(o.now), delta, DAY);
}
