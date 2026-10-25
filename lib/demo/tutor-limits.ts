// The live demo tutor's limits. Every model call is checked against all of them first; any one refusing sends
// the visitor to the saved reply. The Console limit on the demo key ($10) is the real hard cap; these keep the
// daily spend well under it.

import type { CounterStore } from "./tutor-store.ts";

export const LIMITS = {
  /**
   * Model calls one visitor (a signed cookie) gets, then the saved replies. ADVISORY: a request without the cookie
   * gets a fresh id, so this only shapes honest use. The real limits are the per-IP minute and day, the global
   * calls and the daily dollars, and behind them the Console limit on the demo key.
   */
  perVisitor: 20,
  /** Calls per IP per minute. */
  perIpMinute: 6,
  /** Calls per IP per day (a visitor who clears cookies is still one IP). */
  perIpDay: 60,
  /** Calls per day across everyone. */
  dayCalls: 200,
  /** Estimated spend per day across everyone, in millionths of a dollar: $3. */
  dayMicroUsd: 3_000_000,
} as const;

export type Refusal = "rate" | "visitor" | "ip-day" | "day-calls" | "day-budget";

const DAY = 2 * 86_400;
export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Counts this call against every limit and says which one it broke, or null when it may go. The call's worst-case
 * cost (`estimateMicro`) is reserved against the day's budget; `settle` adjusts it to the real cost afterwards.
 */
export interface ExtraOp {
  key: string;
  n: number;
  ttlSec: number;
  /** Given back when the call is refused (a hint that wasn't given); false for a write that stands either way. */
  undo: boolean;
}

export async function checkLimits(store: CounterStore, o: { visitor: string; ip: string; estimateMicro: number; now?: number; extra?: ExtraOp[] }): Promise<Refusal | null> {
  const now = o.now ?? Date.now();
  const day = dayKey(now);
  const minute = Math.floor(now / 60_000);
  // Every counter in ONE request (one round trip to Upstash), in the order of precedence. A hint (and the first answer
  // reported) is written in the same request, before the model is asked, so there is no write to lose afterwards.
  const ops = [
    { key: `rw:tutor:ipm:${o.ip}:${minute}`, n: 1, ttlSec: 120, max: LIMITS.perIpMinute, why: "rate" as Refusal },
    { key: `rw:tutor:v:${o.visitor}`, n: 1, ttlSec: 7 * 86_400, max: LIMITS.perVisitor, why: "visitor" as Refusal },
    { key: `rw:tutor:ipd:${o.ip}:${day}`, n: 1, ttlSec: DAY, max: LIMITS.perIpDay, why: "ip-day" as Refusal },
    { key: `rw:tutor:calls:${day}`, n: 1, ttlSec: DAY, max: LIMITS.dayCalls, why: "day-calls" as Refusal },
    { key: `rw:tutor:micro:${day}`, n: o.estimateMicro, ttlSec: DAY, max: LIMITS.dayMicroUsd, why: "day-budget" as Refusal },
  ];
  const extra = o.extra ?? [];
  const sent = [...ops.map(({ key, n, ttlSec }) => ({ key, n, ttlSec })), ...extra.map(({ key, n, ttlSec }) => ({ key, n, ttlSec }))];
  const values = await store.incrMany(sent);
  const hit = ops.findIndex((op, i) => values[i] > op.max);
  if (hit < 0) return null;
  // Refused: give back what this call reserved, except the counter that refused it (so hammering still trips it) and the
  // per-minute count (so it stays rate-limited). Best effort: a failure here changes nothing about the refusal.
  const undo = sent.map((s, i) => ({ ...s, n: -s.n, i })).filter((s) => s.i !== hit && s.i !== 0 && (s.i < ops.length || extra[s.i - ops.length].undo));
  if (undo.length) await store.incrMany(undo.map(({ key, n, ttlSec }) => ({ key, n, ttlSec }))).catch(() => {});
  return ops[hit].why;
}

/** Replaces the reserved estimate with what the call really cost. */
export async function settle(store: CounterStore, o: { estimateMicro: number; actualMicro: number; now?: number }): Promise<void> {
  const delta = Math.round(o.actualMicro - o.estimateMicro);
  if (delta) await store.incrBy(`rw:tutor:micro:${dayKey(o.now ?? Date.now())}`, delta, DAY);
}

export const hintKey = (visitor: string, questionId: string) => `rw:tutor:h:${visitor}:${questionId}`;
/** The answer first reported for a visitor and question (1 to 4 for A to D). */
export const pinKey = (visitor: string, questionId: string) => `rw:tutor:m:${visitor}:${questionId}`;
