// The live tutor when its counter store (Upstash) is set but not usable: it must refuse the live call and play the
// saved reply, and never count in memory or call the model without its limits checked and reserved.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readDemoBundle, type DemoBundle } from "./bundle";
import type { DemoModel } from "./tutor-llm";
import { handleDemoTutor, type DemoTutorDeps } from "./tutor-route";
import { defaultStore, downStore, memoryStore, StoreDown, upstashStore } from "./tutor-store";

let bundle: DemoBundle;
beforeAll(async () => {
  bundle = (await readDemoBundle())!;
});

type Mode = "network error" | "timeout" | "http 500" | "http 503" | "http 403 budget" | "http 429" | "200 command error (stopped)" | "200 html" | "200 not an array" | "200 wrong length" | "200 non-objects" | "200 bad count";

/** An Upstash that fails in the stated way (after `okCalls` good calls, if given). */
function kvFake(mode: Mode, okCalls = 0): { fetcher: typeof fetch; calls: () => number } {
  let n = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    n++;
    const commands = JSON.parse(String(init.body)) as unknown[][];
    if (n <= okCalls) return new Response(JSON.stringify(commands.map((c) => ({ result: c[0] === "GET" ? null : 1 }))), { status: 200 });
    switch (mode) {
      case "network error":
        throw new TypeError("fetch failed (ENOTFOUND)");
      case "timeout":
        return new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
      case "http 500":
        return new Response("boom", { status: 500 });
      case "http 503":
        return new Response("down", { status: 503 });
      case "http 403 budget":
        return new Response(JSON.stringify({ error: "ERR max budget exceeded, database stopped" }), { status: 403 });
      case "http 429":
        return new Response(JSON.stringify({ error: "ERR max daily request limit exceeded" }), { status: 429 });
      case "200 command error (stopped)":
        return new Response(JSON.stringify(commands.map(() => ({ error: "ERR max budget exceeded" }))), { status: 200 });
      case "200 html":
        return new Response("<html><body>Bad gateway</body></html>", { status: 200 });
      case "200 not an array":
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      case "200 wrong length":
        return new Response("[]", { status: 200 });
      case "200 non-objects":
        return new Response(JSON.stringify(commands.map(() => 1)), { status: 200 });
      case "200 bad count":
        return new Response(JSON.stringify(commands.map(() => ({ result: "abc" }))), { status: 200 });
    }
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => n };
}

const MODES: Mode[] = ["network error", "timeout", "http 500", "http 503", "http 403 budget", "http 429", "200 command error (stopped)", "200 html", "200 not an array", "200 wrong length", "200 non-objects", "200 bad count"];

const KEY = "demo-key-for-tests-only";
const q0 = () => bundle.sets[0].seed.questions[0];
const post = (body: object) =>
  new Request("http://localhost/api/demo/tutor", { method: "POST", headers: { "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) });
const events = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));

function deps(store: DemoTutorDeps["store"]) {
  const tags: string[] = [];
  const model = vi.fn<(key: string) => DemoModel>(() => async () => ({ reply: { text: "A live reply", claims: [], confirms: false }, inputTokens: 1, outputTokens: 1 }));
  const d: DemoTutorDeps = { key: KEY, model, store, bundle: async () => bundle, secure: false, log: (t) => tags.push(t) };
  return { d, model, tags };
}

describe("the tutor with Upstash set but not usable: saved reply, never the model, never memory", () => {
  for (const mode of MODES) {
    it(`${mode}: the live call is refused and the model client is never made`, async () => {
      const kv = kvFake(mode);
      const { d, model, tags } = deps(upstashStore("https://kv.example.test", "tok", kv.fetcher, 25));
      for (const body of [{ questionId: q0().id, request: "hint" }, { questionId: q0().id, request: "reply", message: "I think it is the heap" }]) {
        const res = await handleDemoTutor(post(body), d);
        expect(res.status).toBe(200);
        expect(await events(res)).toEqual([{ t: "fallback", why: "store" }]);
      }
      expect(model).not.toHaveBeenCalled();
      expect(tags).toEqual(["store-down", "store-down"]);
      expect(kv.calls()).toBeGreaterThan(0);
    });
  }

  it("a store that answers the first read and dies on the limits request still stops the call", async () => {
    for (const okCalls of [1]) {
      const kv = kvFake("http 500", okCalls);
      const { d, model } = deps(upstashStore("https://kv.example.test", "tok", kv.fetcher, 25));
      const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d);
      expect(await events(res)).toEqual([{ t: "fallback", why: "store" }]);
      expect(model).not.toHaveBeenCalled();
    }
  });

  it("never touches the model's key or the reply path when the store fails, and the saved-reply answer carries no text", async () => {
    const { d } = deps(downStore("test"));
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "reply", message: "SECRET-STUDENT-WORDS" }), d);
    const text = await res.text();
    expect(text).not.toContain("SECRET-STUDENT-WORDS");
    expect(text.trim()).toBe(JSON.stringify({ t: "fallback", why: "store" }));
  });

  it("the timeout is short: a store that never answers is down within about a second and a half", async () => {
    const t0 = Date.now();
    const store = upstashStore("https://kv.example.test", "tok", kvFake("timeout").fetcher);
    await expect(store.incrBy("k", 1, 60)).rejects.toBeInstanceOf(StoreDown);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(Date.now() - t0).toBeGreaterThan(1200);
  }, 10_000);

  it("is in memory only when the KV variables are unset; set, or half set, it never is", async () => {
    expect(defaultStore({}).kind).toBe("memory");
    expect(defaultStore({ KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "t" }).kind).toBe("upstash");
    // One without the other is a broken configuration: every call fails, nothing is counted in memory.
    for (const env of [{ KV_REST_API_URL: "https://x" }, { KV_REST_API_TOKEN: "t" }]) {
      const s = defaultStore(env);
      await expect(s.incrBy("k", 1, 1)).rejects.toBeInstanceOf(StoreDown);
      await expect(s.get("k")).rejects.toBeInstanceOf(StoreDown);
      const { d, model } = deps(s);
      expect(await events(await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d))).toEqual([{ t: "fallback", why: "store" }]);
      expect(model).not.toHaveBeenCalled();
    }
    // Unset is the working in-memory path (local dev, tests): a live call goes through and the limits are counted.
    const mem = memoryStore();
    const { d, model } = deps(mem);
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d);
    expect((await events(res)).some((e) => e.t === "done")).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(await mem.get(`rw:tutor:calls:${new Date().toISOString().slice(0, 10)}`)).toBe(1);
  });

  it("a good Upstash is used: the call goes through after the limits are counted there", async () => {
    const sent: string[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      const commands = JSON.parse(String(init.body)) as string[][];
      sent.push(...commands.map((c) => c[0]));
      return new Response(JSON.stringify(commands.map((c) => ({ result: c[0] === "GET" ? null : 1 }))), { status: 200 });
    }) as unknown as typeof fetch;
    const { d, model } = deps(upstashStore("https://kv.example.test", "tok", fetcher, 1000));
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "hint" }), d);
    expect((await events(res)).some((e) => e.t === "done")).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(sent.filter((c) => c === "INCRBY").length).toBeGreaterThanOrEqual(6); // the five limits and this hint, in one request
  });
});
