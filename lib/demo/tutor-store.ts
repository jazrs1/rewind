// Counters for the live demo tutor's limits. On Vercel, in-memory counters are per serverless instance, so when
// KV_REST_API_URL and KV_REST_API_TOKEN exist (Upstash, through Vercel's storage integration) the counters live
// there; otherwise they are in memory, per instance, and the only hard cap is the $10 Console limit on the demo key.
// Only numbers are stored: counts and estimated micro-dollars under hashed ids. Never text, never an IP.

export interface CounterStore {
  /** Adds n (may be negative) to a counter and returns the new value; the key expires ttlSec after the last add. */
  incrBy(key: string, n: number, ttlSec: number): Promise<number>;
  /** Several adds in ONE request (one round trip to Upstash); the new values, in order. */
  incrMany(ops: { key: string; n: number; ttlSec: number }[]): Promise<number[]>;
  get(key: string): Promise<number>;
  /** Several reads in one request; the values in order (0 for a counter that isn't there). */
  getMany(keys: string[]): Promise<number[]>;
  readonly kind: "memory" | "upstash";
}

export function memoryStore(now: () => number = Date.now): CounterStore {
  const m = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.exp <= now()) m.delete(k);
    return m.get(k);
  };
  return {
    kind: "memory",
    async incrBy(key, n, ttlSec) {
      const v = (live(key)?.v ?? 0) + n;
      m.set(key, { v, exp: now() + ttlSec * 1000 });
      // A small map: drop the oldest when it grows.
      if (m.size > 5000) m.delete(m.keys().next().value!);
      return v;
    },
    async incrMany(ops) {
      const out: number[] = [];
      for (const o of ops) out.push(await this.incrBy(o.key, o.n, o.ttlSec));
      return out;
    },
    async get(key) {
      return live(key)?.v ?? 0;
    },
    async getMany(keys) {
      return Promise.all(keys.map((k) => this.get(k)));
    },
  };
}

/** How long one counter request may take before the store counts as down. */
export const STORE_TIMEOUT_MS = 1500;

/**
 * The counters can't be used: unreachable, timed out, stopped (Upstash refuses once its budget is spent), a 4xx/5xx,
 * a command error or a reply that isn't what was asked for. The tutor treats it as "no live call": the page plays the
 * saved reply. It is never answered from memory when Upstash is configured, and the message carries no secret.
 */
export class StoreDown extends Error {
  constructor(why: string) {
    super(`counter store down (${why})`);
    this.name = "StoreDown";
  }
}

/** Upstash's REST pipeline: one POST with a list of commands. Any failure throws StoreDown (the caller falls back). */
export function upstashStore(url: string, token: string, fetcher: typeof fetch = fetch, timeoutMs: number = STORE_TIMEOUT_MS): CounterStore {
  // The token travels in a header: only over https.
  if (!/^https:\/\/[^/\s]/i.test(url.trim())) return downStore("kv url is not https");
  const run = async (commands: (string | number)[][]) => {
    let res: Response;
    try {
      res = await fetcher(`${url.replace(/\/$/, "")}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StoreDown((e as Error)?.name === "TimeoutError" ? "timeout" : "network");
    }
    if (!res.ok) throw new StoreDown(`http ${res.status}`);
    let out: unknown;
    try {
      out = await res.json();
    } catch {
      throw new StoreDown("bad json");
    }
    if (!Array.isArray(out) || out.length !== commands.length || out.some((r) => !r || typeof r !== "object")) throw new StoreDown("bad reply");
    if ((out as { error?: unknown }[]).some((r) => r.error)) throw new StoreDown("command error");
    return out as { result?: unknown }[];
  };
  /** A counter as Upstash gives it: an integer, or an integer in a string. Anything else (an empty string, spaces, an array, an object) is nonsense. */
  const count = (v: unknown): number => {
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
    if (typeof v === "string" && /^-?\d{1,15}$/.test(v)) return Number(v);
    throw new StoreDown("bad count");
  };
  return {
    kind: "upstash",
    async incrBy(key, n, ttlSec) {
      const out = await run([["INCRBY", key, n], ["EXPIRE", key, ttlSec]]);
      return count(out[0].result);
    },
    async incrMany(ops) {
      if (!ops.length) return [];
      const out = await run(ops.flatMap((o) => [["INCRBY", o.key, o.n], ["EXPIRE", o.key, o.ttlSec]]));
      return ops.map((_, i) => count(out[i * 2].result));
    },
    async get(key) {
      const v = (await run([["GET", key]]))[0].result;
      return v === null || v === undefined ? 0 : count(v);
    },
    async getMany(keys) {
      if (!keys.length) return [];
      const out = await run(keys.map((k) => ["GET", k]));
      return out.map((r) => (r.result === null || r.result === undefined ? 0 : count(r.result)));
    },
  };
}

/** A store whose every call fails: what a half-set Upstash configuration gets, so it can't fall back to memory. */
export function downStore(why: string): CounterStore {
  const fail = async (): Promise<never> => {
    throw new StoreDown(why);
  };
  return { kind: "upstash", incrBy: fail, incrMany: fail, get: fail, getMany: fail };
}

type Env = Record<string, string | undefined>;

const KEY = Symbol.for("rewind.demo.tutor.store");

/**
 * Upstash when its two variables are set. In memory (one store per instance, kept on globalThis) ONLY when neither is
 * set (local dev and tests, never when VERCEL is set). One set without the other, or a URL that isn't https, is a broken
 * configuration: every call fails, so the tutor plays saved replies instead of counting in memory.
 */
export function defaultStore(env: Env = process.env): CounterStore {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (url && token) return upstashStore(url, token);
  if (url || token) return downStore("half-configured");
  // On Vercel there is always a store: no variables there means a broken deploy, which must fail closed, not count in memory.
  if (env.VERCEL) return downStore("no kv on vercel");
  const g = globalThis as unknown as Record<symbol, CounterStore | undefined>;
  return (g[KEY] ??= memoryStore());
}
