// The account store's backend: Upstash Redis over its REST API (the Vercel KV / Upstash env vars
// KV_REST_API_URL and KV_REST_API_TOKEN), or an in-memory fake for tests that follows the same rules.
// No client package: a few commands over fetch. Values are never logged.
//
// Per user (key names in lib/accounts/handler.ts): a hash of attempt id → record JSON, a sorted set of
// attempt ids by answer time, and after "Delete my data" a deletion mark (a time, no answers). Every
// write is atomic, so two devices syncing at once, or a sync racing a delete, can't lose an attempt or
// bring a deleted one back:
// - merge is one Lua script: per id the newer answer wins, anything answered at or before the deletion
//   mark is ignored, and an account holding `max` answers takes no new ones (it reports them as over the
//   limit; nothing already stored is dropped, and answers it already has can still be updated);
// - delete-all is one Lua script: the data keys go, and the mark becomes the server's time of the delete
//   (`nowMs`), never a device's clock, so re-uploads of deleted answers are refused and real answers given
//   after it go in, whatever the device that deleted had for a clock. A per-course delete sets no mark.

import type { AccountAttempt } from "./schema.ts";

export interface UserKeys {
  hash: string;
  byTime: string;
  deletedMark: string;
}

export interface AccountKV {
  list(keys: UserKeys): Promise<AccountAttempt[]>;
  /** Merges atomically (see above): the account's records, and the new ids refused because the account was full. */
  merge(keys: UserKeys, attempts: AccountAttempt[], max: number): Promise<{ attempts: AccountAttempt[]; overLimit: string[] }>;
  /** Removes these attempt ids. */
  remove(keys: UserKeys, ids: string[]): Promise<void>;
  /** The deletion mark (ms; 0 when there is none): every answer dated at or before it was deleted. */
  mark(keys: UserKeys): Promise<number>;
  /** Removes every attempt and sets the deletion mark to `nowMs` (the server's time of the delete), atomically. */
  removeAll(keys: UserKeys, markTtlSec: number, nowMs: number): Promise<void>;
  /** Adds 1 and returns the new count; a new key expires after `ttlSec`. */
  incr(key: string, ttlSec: number): Promise<number>;
}

const ms = (a: AccountAttempt) => {
  const t = Date.parse(a?.answeredAt);
  return Number.isFinite(t) ? t : 0;
};

const byTime = (list: AccountAttempt[]) => list.sort((a, b) => ms(a) - ms(b) || String(a?.id).localeCompare(String(b?.id)));

/**
 * The hash's values as records. Nothing (null) is an empty account. Anything that is there but isn't a list of JSON strings
 * is StorageUnavailable: skipping it would show the account as emptier than it is (readStoredAttempts, in the handler,
 * checks each record against the schema the same way).
 */
function parseAll(values: unknown): AccountAttempt[] {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) throw new StorageUnavailable("bad value");
  const out: AccountAttempt[] = [];
  for (const v of values as string[]) {
    try {
      out.push(JSON.parse(v) as AccountAttempt);
    } catch {
      throw new StorageUnavailable("stored value is not JSON");
    }
  }
  return byTime(out);
}

/**
 * KEYS: hash, byTime, deletedMark. ARGV: max, then id, ms, json for each attempt (in the order sent). Returns
 * { new ids refused because the account already held `max`, the hash's values }.
 */
export const MERGE_SCRIPT = `
local mark = tonumber(redis.call('GET', KEYS[3]) or '0')
local max = tonumber(ARGV[1])
local count = redis.call('ZCARD', KEYS[2])
local full = {}
for i = 2, #ARGV, 3 do
  local id, t, v = ARGV[i], tonumber(ARGV[i + 1]), ARGV[i + 2]
  if t > mark then
    local old = redis.call('ZSCORE', KEYS[2], id)
    if old then
      if tonumber(old) < t then
        redis.call('HSET', KEYS[1], id, v)
        redis.call('ZADD', KEYS[2], t, id)
      end
    elseif count >= max then
      table.insert(full, id)
    else
      redis.call('HSET', KEYS[1], id, v)
      redis.call('ZADD', KEYS[2], t, id)
      count = count + 1
    end
  end
end
return {full, redis.call('HVALS', KEYS[1])}
`;

/** KEYS: hash, byTime, deletedMark. ARGV: the mark's TTL in seconds, the server's time of the delete (ms). */
export const DELETE_ALL_SCRIPT = `
local mark = tonumber(redis.call('GET', KEYS[3]) or '0')
local now = tonumber(ARGV[2])
if now > mark then mark = now end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('SET', KEYS[3], mark, 'EX', ARGV[1])
return mark
`;

type Command = (string | number)[];

/** How long one storage request may take before it counts as down. */
export const KV_TIMEOUT_MS = 1500;

/**
 * The storage can't be used right now: unreachable, timed out, stopped (Upstash refuses once its budget is spent),
 * a 4xx/5xx, an error in a command, or an answer that isn't what was asked for. Callers turn it into a clean refusal;
 * the message never carries a key, a value or the token.
 */
export class StorageUnavailable extends Error {
  constructor(why: string) {
    super(`storage unavailable (${why})`);
    this.name = "StorageUnavailable";
  }
}

export function upstashKV(url: string, token: string, fetchFn: typeof fetch = fetch, timeoutMs: number = KV_TIMEOUT_MS): AccountKV {
  const base = url.replace(/\/+$/, "");
  // The token travels in a header: only over https.
  if (!/^https:\/\/[^/\s]/i.test(base)) {
    const refuse = async (): Promise<never> => {
      throw new StorageUnavailable("kv url is not https");
    };
    return { list: refuse, merge: refuse, remove: refuse, mark: refuse, removeAll: refuse, incr: refuse };
  }
  /** `pipeline` runs the commands in order; `multi-exec` runs them as one transaction. Any failure is StorageUnavailable. */
  const send = async (path: "pipeline" | "multi-exec", commands: Command[]): Promise<unknown[]> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StorageUnavailable((e as Error)?.name === "TimeoutError" ? "timeout" : "network");
    }
    if (!res.ok) throw new StorageUnavailable(`http ${res.status}`);
    let out: unknown;
    try {
      out = await res.json();
    } catch {
      throw new StorageUnavailable("bad json");
    }
    if (!Array.isArray(out) || out.length !== commands.length || out.some((r) => !r || typeof r !== "object")) throw new StorageUnavailable("bad reply");
    if ((out as { error?: unknown }[]).some((r) => r.error)) throw new StorageUnavailable("command error");
    return (out as { result?: unknown }[]).map((r) => r.result);
  };
  return {
    async list(keys) {
      const [values] = await send("pipeline", [["HVALS", keys.hash]]);
      return parseAll(values);
    },
    async merge(keys, attempts, max) {
      const args = attempts.flatMap((a) => [a.id, ms(a), JSON.stringify(a)]);
      const [reply] = await send("pipeline", [["EVAL", MERGE_SCRIPT, 3, keys.hash, keys.byTime, keys.deletedMark, max, ...args]]);
      if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[0]) || reply[0].some((i) => typeof i !== "string")) throw new StorageUnavailable("bad merge reply");
      return { attempts: parseAll(reply[1]), overLimit: reply[0] as string[] };
    },
    async remove(keys, ids) {
      if (ids.length) await send("multi-exec", [["HDEL", keys.hash, ...ids], ["ZREM", keys.byTime, ...ids]]);
    },
    async mark(keys) {
      const [v] = await send("pipeline", [["GET", keys.deletedMark]]);
      if (v === null || v === undefined) return 0;
      const n = typeof v === "string" ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new StorageUnavailable("bad mark");
      return n;
    },
    async removeAll(keys, markTtlSec, nowMs) {
      await send("pipeline", [["EVAL", DELETE_ALL_SCRIPT, 3, keys.hash, keys.byTime, keys.deletedMark, markTtlSec, Math.floor(nowMs)]]);
    },
    async incr(key, ttlSec) {
      const [n] = await send("pipeline", [["INCR", key], ["EXPIRE", key, ttlSec, "NX"]]);
      const count = typeof n === "string" ? Number(n) : n;
      if (typeof count !== "number" || !Number.isFinite(count)) throw new StorageUnavailable("bad count");
      return count;
    },
  };
}

/** The same rules in memory (one thread, so every call is atomic). `down` makes every call fail, like a stopped database. */
export function memoryKV(now: () => number = Date.now): AccountKV & { keys(): string[]; down: boolean } {
  const hashes = new Map<string, Map<string, AccountAttempt>>();
  const values = new Map<string, { value: string; expires: number | null }>();
  const live = (key: string) => {
    const e = values.get(key);
    if (e && e.expires !== null && e.expires <= now()) values.delete(key);
    return values.get(key);
  };
  const kv = {
    down: false,
    check() {
      if (kv.down) throw new StorageUnavailable("down");
    },
    async list(keys: UserKeys) {
      kv.check();
      return byTime([...(hashes.get(keys.hash)?.values() ?? [])]);
    },
    async merge(keys: UserKeys, attempts: AccountAttempt[], max: number) {
      kv.check();
      const mark = Number(live(keys.deletedMark)?.value ?? 0);
      const h = hashes.get(keys.hash) ?? new Map<string, AccountAttempt>();
      const overLimit: string[] = [];
      for (const a of attempts) {
        if (ms(a) <= mark) continue;
        const old = h.get(a.id);
        if (old) {
          if (ms(old) < ms(a)) h.set(a.id, a);
        } else if (h.size >= max) overLimit.push(a.id);
        else h.set(a.id, a);
      }
      if (h.size) hashes.set(keys.hash, h);
      return { attempts: byTime([...h.values()]), overLimit };
    },
    async mark(keys: UserKeys) {
      kv.check();
      return Number(live(keys.deletedMark)?.value ?? 0);
    },
    async remove(keys: UserKeys, ids: string[]) {
      kv.check();
      const h = hashes.get(keys.hash);
      for (const id of ids) h?.delete(id);
      if (h && !h.size) hashes.delete(keys.hash);
    },
    async removeAll(keys: UserKeys, markTtlSec: number, nowMs: number) {
      kv.check();
      const mark = Math.max(Number(live(keys.deletedMark)?.value ?? 0), Math.floor(nowMs));
      hashes.delete(keys.hash);
      values.set(keys.deletedMark, { value: String(mark), expires: now() + markTtlSec * 1000 });
    },
    async incr(key: string, ttlSec: number) {
      kv.check();
      const e = live(key);
      const n = (e ? Number(e.value) : 0) + 1;
      values.set(key, { value: String(n), expires: e?.expires ?? now() + ttlSec * 1000 });
      return n;
    },
    keys: () => [...hashes.keys(), ...[...values.keys()].filter((k) => live(k))],
  };
  return kv;
}
