// Quick build's own budget and caps, separate from the live tutor's on the same demo key (Q-SEC 1): neither can use
// up the other's allowance, and together they stay under the key's $10 Console limit. Fake store and fake model.
import { describe, expect, it } from "vitest";
import { checkLimits, dayKey, LIMITS as TUTOR } from "../demo/tutor-limits.ts";
import { memoryStore } from "../demo/tutor-store.ts";
import { BudgetStop, callsKey, KEY_LIMIT_MICRO_USD, microKey, QUICK_LIMITS, reserveCall, SHARED_KEY_DAY_MICRO_USD } from "./limits.ts";
import { course, deps, fiveChunks, send } from "./test-helpers.ts";

const NOW = Date.parse("2026-10-25T15:00:00Z");
const tutorCall = (store: ReturnType<typeof memoryStore>) => checkLimits(store, { visitor: "v1", ip: "ip1", estimateMicro: 2_000, now: NOW });

describe("Quick build's own day budget and calls", () => {
  it("$8 a day and 3,000 calls, its own; with the tutor's $3, under the key's $30", () => {
    expect(QUICK_LIMITS.dayMicroUsd).toBe(8_000_000);
    expect(QUICK_LIMITS.dayCalls).toBe(3_000);
    expect(SHARED_KEY_DAY_MICRO_USD).toBe(QUICK_LIMITS.dayMicroUsd + TUTOR.dayMicroUsd);
    expect(SHARED_KEY_DAY_MICRO_USD).toBeLessThan(KEY_LIMIT_MICRO_USD);
    // Its counters are its own keys, never the tutor's.
    expect(microKey(NOW)).toBe(`rw:quick:micro:${dayKey(NOW)}`);
    expect(callsKey(NOW)).toBe(`rw:quick:calls:${dayKey(NOW)}`);
  });

  it("exhausting Quick's dollars stops Quick, and leaves the tutor's allowance untouched", async () => {
    const store = memoryStore(() => NOW);
    await store.incrBy(microKey(NOW), QUICK_LIMITS.dayMicroUsd, 172_800);
    await expect(reserveCall(store, 10_000, NOW)).rejects.toBeInstanceOf(BudgetStop);
    // Given back: still exactly at the limit, not over it.
    expect(await store.get(microKey(NOW))).toBe(QUICK_LIMITS.dayMicroUsd);
    expect(await tutorCall(store)).toBeNull();
    expect(await store.get(`rw:tutor:micro:${dayKey(NOW)}`)).toBe(2_000);
  });

  it("exhausting Quick's calls stops Quick (both counters given back), and the tutor still answers", async () => {
    const store = memoryStore(() => NOW);
    await store.incrBy(callsKey(NOW), QUICK_LIMITS.dayCalls, 172_800);
    await expect(reserveCall(store, 10_000, NOW)).rejects.toBeInstanceOf(BudgetStop);
    expect(await store.get(callsKey(NOW))).toBe(QUICK_LIMITS.dayCalls);
    expect(await store.get(microKey(NOW))).toBe(0);
    expect(await tutorCall(store)).toBeNull();
  });

  it("the reverse: the tutor's day spent (dollars and calls) leaves Quick's untouched", async () => {
    const store = memoryStore(() => NOW);
    await store.incrBy(`rw:tutor:micro:${dayKey(NOW)}`, TUTOR.dayMicroUsd, 172_800);
    await store.incrBy(`rw:tutor:calls:${dayKey(NOW)}`, TUTOR.dayCalls, 172_800);
    expect(await tutorCall(store)).toMatch(/day-calls|day-budget/);
    await expect(reserveCall(store, 10_000, NOW)).resolves.toBeUndefined();
    expect(await store.get(microKey(NOW))).toBe(10_000);
    expect(await store.get(callsKey(NOW))).toBe(1);
  });

  it("through the route: with the tutor's day spent, Quick still writes; with Quick's spent, it calls no model", async () => {
    const tutorSpent = memoryStore(() => NOW);
    await tutorSpent.incrBy(`rw:tutor:micro:${dayKey(NOW)}`, TUTOR.dayMicroUsd, 172_800);
    const a = deps({ store: tutorSpent, now: () => NOW });
    const r = await send({ course, chunks: fiveChunks() }, a);
    expect(r.status).toBe(200);
    expect(r.json.questions!.length).toBeGreaterThan(0);

    const quickSpent = memoryStore(() => NOW);
    await quickSpent.incrBy(microKey(NOW), QUICK_LIMITS.dayMicroUsd, 172_800);
    const b = deps({ store: quickSpent, now: () => NOW });
    const r2 = await send({ course, chunks: fiveChunks() }, b);
    expect(r2.json.questions ?? []).toEqual([]);
    expect(b.calls.model).toBe(0);
    expect(await tutorCall(quickSpent)).toBeNull();
  });
});
