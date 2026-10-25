// One deadline for the pre-model phase, the hint written before the model, strict counters, https and Vercel rules.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readDemoBundle, type DemoBundle } from "./bundle";
import { LIMITS } from "./tutor-limits";
import type { DemoModel } from "./tutor-llm";
import { handleDemoTutor, PRE_MODEL_MS, type DemoTutorDeps } from "./tutor-route";
import { defaultStore, memoryStore, StoreDown, upstashStore, type CounterStore } from "./tutor-store";

let bundle: DemoBundle;
beforeAll(async () => {
  bundle = (await readDemoBundle())!;
});

const q0 = () => bundle.sets[0].seed.questions[0];
const post = (body: object, init: RequestInit = {}) =>
  new Request("http://localhost/api/demo/tutor", { method: "POST", headers: { "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body), ...init });
const events = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** A store that works but takes `ms` over every call. */
function slow(ms: number, inner: CounterStore = memoryStore()): CounterStore & { calls: number } {
  const wait = <T,>(v: () => Promise<T>) => new Promise<T>((r) => setTimeout(() => r(v()), ms));
  const s = {
    calls: 0,
    kind: inner.kind,
    incrBy: (k: string, n: number, t: number) => (s.calls++, wait(() => inner.incrBy(k, n, t))),
    incrMany: (o: { key: string; n: number; ttlSec: number }[]) => (s.calls++, wait(() => inner.incrMany(o))),
    get: (k: string) => (s.calls++, wait(() => inner.get(k))),
    getMany: (k: string[]) => (s.calls++, wait(() => inner.getMany(k))),
  };
  return s;
}

function deps(store: CounterStore, over: Partial<DemoTutorDeps> = {}) {
  const tags: string[] = [];
  const model = vi.fn<(key: string) => DemoModel>(() => async () => ({ reply: { text: "A live reply", claims: [], confirms: false }, inputTokens: 1, outputTokens: 1 }));
  const d: DemoTutorDeps = { key: "demo-key-for-tests-only", model, store, bundle: async () => bundle, secure: false, log: (t) => tags.push(t), ...over };
  return { d, model, tags };
}

describe("one deadline for everything before the model", () => {
  it("is shorter than the page's 8 seconds", () => {
    expect(PRE_MODEL_MS).toBeLessThan(8000);
  });

  it("a store that answers every call in 1.4 s: the model is never called once the deadline passes", async () => {
    // 1.4 s per call: the first read finishes, the limits request would end after the deadline.
    const store = slow(1400);
    const { d, model, tags } = deps(store, { preModelMs: 2000 });
    const t0 = Date.now();
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d);
    expect(await events(res)).toEqual([{ t: "fallback", why: "store" }]);
    expect(model).not.toHaveBeenCalled();
    expect(tags).toEqual(["store-down"]);
    // It gave up at the deadline, not after the second 1.4 s.
    expect(Date.now() - t0).toBeLessThan(2600);
  }, 10_000);

  it("the whole phase is two store requests now, so a store at 1.4 s a call still fits the real deadline and the model is called", async () => {
    const store = slow(1400);
    const { d, model } = deps(store);
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d);
    expect((await events(res)).some((e) => e.t === "done")).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(store.calls).toBe(3); // the read, the limits request, and settling the real cost afterwards
  }, 10_000);

  it("eight calls at 1.4 s (the old sequence) could not delay the answer past the deadline: the model is never called", async () => {
    // A store whose pipeline is gone: each request is its own slow round trip, and more of them than the deadline allows.
    const inner = memoryStore();
    let calls = 0;
    const wait = <T,>(v: () => Promise<T>) => new Promise<T>((r) => setTimeout(() => r(v()), 1400));
    const sequential: CounterStore = {
      kind: "memory",
      incrBy: (k, n, t) => (calls++, wait(() => inner.incrBy(k, n, t))),
      incrMany: async (ops) => {
        const out: number[] = [];
        for (const o of ops) out.push(await sequential.incrBy(o.key, o.n, o.ttlSec));
        return out;
      },
      get: (k) => (calls++, wait(() => inner.get(k))),
      getMany: async (keys) => Promise.all(keys.map((k) => sequential.get(k))),
    };
    const { d, model } = deps(sequential, { preModelMs: 3000 });
    const t0 = Date.now();
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint", marked: "A" }), d);
    expect(await events(res)).toEqual([{ t: "fallback", why: "store" }]);
    expect(model).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(3600);
    expect(calls).toBeGreaterThan(2);
  }, 15_000);

  it("stops when the client goes away: no model call", async () => {
    const ac = new AbortController();
    const store = slow(500);
    const { d, model } = deps(store);
    const pending = handleDemoTutor(post({ questionId: q0().id, request: "hint" }, { signal: ac.signal }), d);
    setTimeout(() => ac.abort(), 100);
    expect(await events(await pending)).toEqual([{ t: "fallback", why: "store" }]);
    expect(model).not.toHaveBeenCalled();
  });
});

describe("the hint is counted before the model is asked, in the same request as the limits", () => {
  it("a hint request writes the hint counter with the limits; a failure there is a store failure, not a swallowed write", async () => {
    const seen: string[][] = [];
    const inner = memoryStore();
    const store: CounterStore = { ...inner, incrMany: async (ops) => (seen.push(ops.map((o) => o.key.split(":")[2])), inner.incrMany(ops)) };
    const { d, model } = deps(store);
    await events(await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["ipm", "v", "ipd", "calls", "micro", "h"]);
    expect(model).toHaveBeenCalledTimes(1);

    const broken: CounterStore = { ...inner, incrMany: async () => Promise.reject(new StoreDown("write failed")) };
    const b = deps(broken);
    expect(await events(await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), b.d))).toEqual([{ t: "fallback", why: "store" }]);
    expect(b.model).not.toHaveBeenCalled();
  });

  it("a refused call gives the hint and the reservations back, but keeps the minute count that refused it", async () => {
    const store = memoryStore();
    const { d } = deps(store);
    const day = new Date().toISOString().slice(0, 10);
    // Fill the day's call cap so the next call is refused by it.
    await store.incrBy(`rw:tutor:calls:${day}`, LIMITS.dayCalls, 3600);
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d);
    expect(await events(res)).toEqual([{ t: "fallback", why: "day-calls" }]);
    expect(await store.get(`rw:tutor:micro:${day}`)).toBe(0);
    expect(await store.get(`rw:tutor:calls:${day}`)).toBeGreaterThan(LIMITS.dayCalls);
  });
});

describe("counters are strict, https is required, Vercel never counts in memory", () => {
  const upstashWith = (result: unknown) =>
    upstashStore("https://kv.example.test", "tok", (async (_u: string, init: RequestInit) => new Response(JSON.stringify(JSON.parse(String(init.body)).map(() => ({ result }))), { status: 200 })) as unknown as typeof fetch, 1000);

  it("get() accepts a missing counter, an integer and a digit string, and rejects an empty string, spaces, arrays, objects and fractions", async () => {
    expect(await upstashWith(null).get("k")).toBe(0);
    expect(await upstashWith(5).get("k")).toBe(5);
    expect(await upstashWith("7").get("k")).toBe(7);
    for (const bad of ["", " ", "  ", [], [5], {}, "1.5", 1.5, "abc", "5 ", true]) {
      await expect(upstashWith(bad).get("k"), JSON.stringify(bad)).rejects.toBeInstanceOf(StoreDown);
    }
    await expect(upstashWith("").incrBy("k", 1, 1)).rejects.toBeInstanceOf(StoreDown);
    await expect(upstashWith([]).getMany(["a", "b"])).rejects.toBeInstanceOf(StoreDown);
    await expect(upstashWith(" ").incrMany([{ key: "a", n: 1, ttlSec: 1 }])).rejects.toBeInstanceOf(StoreDown);
  });

  it("a KV URL that isn't https fails closed, the token is never sent", async () => {
    let sent = 0;
    const fetcher = (async () => (sent++, new Response("[]"))) as unknown as typeof fetch;
    for (const url of ["http://kv.example.test", "ftp://x", "kv.example.test", "", "  https://"]) {
      const s = upstashStore(url, "tok", fetcher, 100);
      await expect(s.get("k"), url).rejects.toBeInstanceOf(StoreDown);
      await expect(s.incrMany([{ key: "a", n: 1, ttlSec: 1 }]), url).rejects.toBeInstanceOf(StoreDown);
    }
    expect(sent).toBe(0);
    expect(defaultStore({ KV_REST_API_URL: "http://127.0.0.1:9", KV_REST_API_TOKEN: "t" }).kind).toBe("upstash");
    await expect(defaultStore({ KV_REST_API_URL: "http://x", KV_REST_API_TOKEN: "t" }).get("k")).rejects.toBeInstanceOf(StoreDown);
  });

  it("on Vercel, no KV variables, or empty ones, is a broken deploy: every call fails and nothing is counted in memory", async () => {
    for (const env of [{ VERCEL: "1" }, { VERCEL: "1", KV_REST_API_URL: "", KV_REST_API_TOKEN: "" }]) {
      const s = defaultStore(env);
      await expect(s.incrMany([{ key: "a", n: 1, ttlSec: 1 }])).rejects.toBeInstanceOf(StoreDown);
      await expect(s.getMany(["a"])).rejects.toBeInstanceOf(StoreDown);
      const { d, model } = deps(s);
      expect(await events(await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d))).toEqual([{ t: "fallback", why: "store" }]);
      expect(model).not.toHaveBeenCalled();
    }
    // Off Vercel and unset: the in-memory store (local dev, tests).
    expect(defaultStore({}).kind).toBe("memory");
  });
});
