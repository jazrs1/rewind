// The account API (app/api/account/attempts/route.ts), as a plain function so tests can run it with a
// fake user and the in-memory store. Every key is under the signed-in user's id, which the caller
// takes from the verified session; nothing in the body or query can name another user.
//
// GET: the account's attempts. POST { attempts }: merge them in (by id, newer wins; lib/accounts/kv.ts)
// and return the result, with every record it refused and why (`refused: [{ id, reason }]`), never the
// whole request:
// - "future": answered more than FUTURE_SLACK_MS after the server's time (a device clock running ahead);
//   the browser keeps it and sends it again;
// - "older-than-delete": answered at or before the deletion mark; the browser removes it;
// - "over-limit": a new answer while the account holds MAX_ATTEMPTS; the browser keeps it and stops
//   sending it, and the menu says the account is full.
// GET and POST also return `deletedBefore`: the deletion mark, the server's time of the last "Delete my data"
// (null when there is none; a per-course delete sets none). It is the one signal that confirmed answers on
// other devices were deleted: a browser removes a confirmed answer only when it is dated at or before it, never
// because a list lacks it. And `serverTime`, so a browser whose clock runs ahead holds future-dated answers
// until the server's time reaches them instead of re-sending them.
//
// Cost limits (the database stops at its budget, and the demo tutor's limiter shares it): per user, 30 writes
// and 60 reads a minute; for everyone together, GLOBAL_WRITES_PER_DAY writes a UTC day, after which every
// write answers 503 like any storage failure ("Saving is unavailable right now"), and globalReadsPerDay(env) reads,
// after which a GET answers 503 "reads-paused" (the menu says syncing is paused; the device keeps everything). Deletes
// ("Delete my data" and a course's clear) are never under the global caps (F3: a delete must always work); they have
// their own per-user counter, DELETES_PER_MINUTE, apart from the writes. DELETE: every attempt, and a deletion mark so an older device can't upload
// them again; DELETE ?course=X: that course's attempts only. POST and DELETE must come from this
// site (Origin matches Host) and are rate-limited per user; "Delete my data" leaves the rate-limit
// counter to expire on its own. When the store is unreachable or stopped (Upstash's budget cap),
// every call answers 503 and the browser keeps practice on the device. Nothing here logs record contents.

import { accountsEnabled } from "./flag.ts";
import type { AccountKV, UserKeys } from "./kv.ts";
import { MAX_ATTEMPTS, parseAttemptsBody, readStoredAttempts, type AccountAttempt } from "./schema.ts";

export const WRITES_PER_MINUTE = 30;
export const READS_PER_MINUTE = 60;
/** Every account's writes together, per UTC day: disposable sign-ups each get a fresh per-user quota, this one they share. */
export const GLOBAL_WRITES_PER_DAY = 100_000;
/**
 * Every account's GETs together, per UTC day, unless REWIND_ACCOUNT_READS_PER_DAY says otherwise. A GET is about 5
 * storage commands, so 20,000 is about 100,000 commands a day (about $0.20 at Upstash's pay-as-you-go price), well
 * under the database's budget, which the demo tutor's limiter shares.
 */
export const GLOBAL_READS_PER_DAY = 20_000;
/** Per user, apart from the writes: a delete is never blocked by the student's own saving. */
export const DELETES_PER_MINUTE = 10;
/** The error code of a GET refused by the global read cap. */
export const READS_PAUSED = "reads-paused";
/** A reply is at most this big (2,000 records are well under it); anything larger is treated as storage trouble. */
export const MAX_REPLY_BYTES = 512 * 1024;
/** How far after the server's time an answer may be dated (device clocks drift); later ones are ignored. */
export const FUTURE_SLACK_MS = 5 * 60_000;
/** How long the deletion mark stays after "Delete my data" (no answers in it: the newest deleted answer's time). */
export const DELETED_MARK_TTL_SEC = 400 * 24 * 3600;

export function userKeys(userId: string): UserKeys {
  const base = `rewind:v1:user:${userId}`;
  return { hash: `${base}:attempts`, byTime: `${base}:attempts-by-time`, deletedMark: `${base}:deleted-at` };
}

export const rateKey = (userId: string) => `rewind:v1:user:${userId}:writes`;
export const readRateKey = (userId: string) => `rewind:v1:user:${userId}:reads`;
export const globalWritesKey = (nowMs: number) => `rewind:v1:global:writes:${new Date(nowMs).toISOString().slice(0, 10)}`;
export const globalReadsKey = (nowMs: number) => `rewind:v1:global:reads:${new Date(nowMs).toISOString().slice(0, 10)}`;
export const deleteRateKey = (userId: string) => `rewind:v1:user:${userId}:deletes`;

/** The global daily read cap: REWIND_ACCOUNT_READS_PER_DAY when it is a positive whole number, else GLOBAL_READS_PER_DAY. */
export function globalReadsPerDay(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.REWIND_ACCOUNT_READS_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : GLOBAL_READS_PER_DAY;
}

export interface AccountRequest {
  method: string;
  url: string;
  /** The raw body text (POST). */
  body?: string;
  /** The request's Origin and Host headers (POST and DELETE must be same-site). */
  origin?: string | null;
  host?: string | null;
  /** The user the page thinks is signed in (x-rewind-user), when it says: a different session gets 409 (a stale tab). */
  expectedUser?: string | null;
}

/** The error code every storage failure answers with (the page says "Saving is unavailable right now"). */
export const UNAVAILABLE = "storage-unavailable";

export type RefusedReason = "future" | "older-than-delete" | "over-limit";
export interface Refused {
  id: string;
  reason: RefusedReason;
}
export const STORAGE_UNAVAILABLE = UNAVAILABLE;

export interface AccountResponse {
  status: number;
  json: { attempts: AccountAttempt[]; refused?: Refused[]; deletedBefore: string | null; serverTime: string } | { deleted: true } | { error: string };
}

type Env = Record<string, string | undefined>;

/** Same-site check for writes: the Origin header's host must equal the Host header. */
export function sameOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function handleAccountRequest(req: AccountRequest, userId: string | null, kv: () => AccountKV | null, env: Env = process.env, now: () => number = Date.now): Promise<AccountResponse> {
  if (!accountsEnabled(env)) return { status: 404, json: { error: "not found" } };
  if (!userId) return { status: 401, json: { error: "sign in first" } };
  // A tab still showing an earlier user's session (signed out, someone else signed in since): nothing of it may reach this account.
  if (req.expectedUser && req.expectedUser !== userId) return { status: 409, json: { error: "signed in as someone else" } };
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") return { status: 405, json: { error: "method not allowed" } };
  if (req.method !== "GET" && !sameOrigin(req.origin, req.host)) return { status: 403, json: { error: "cross-site request" } };
  // Check the body before touching storage: a bad request costs nothing and counts for nothing.
  const parsed = req.method === "POST" ? parseAttemptsBody(req.body ?? "") : null;
  if (parsed && !parsed.ok) return { status: parsed.error === "body too large" ? 413 : 400, json: { error: parsed.error } };

  // Storage that is unset, unreachable, stopped (its budget spent), slow, corrupt or answering nonsense is one clear
  // answer: 503 storage-unavailable. Writes are atomic in the store (lib/accounts/kv.ts), so a failure never leaves half
  // a change behind.
  try {
    const store = kv();
    if (!store) return UNAVAILABLE_RESPONSE;
    const keys = userKeys(userId);

    // Read after the list: the mark only moves forward, so a delete in between can only make it later (still right).
    const reply = async (attempts: AccountAttempt[], refused?: Refused[]): Promise<AccountResponse> => {
      const m = await store.mark(keys);
      const json = { attempts, ...(refused ? { refused } : {}), deletedBefore: m > 0 ? new Date(m).toISOString() : null, serverTime: new Date(now()).toISOString() };
      if (JSON.stringify(json).length > MAX_REPLY_BYTES) return UNAVAILABLE_RESPONSE;
      return { status: 200, json };
    };
    if (req.method === "GET") {
      if ((await store.incr(readRateKey(userId), 60)) > READS_PER_MINUTE) return { status: 429, json: { error: "too many reads; try again in a minute" } };
      // Everyone's reads today, together: past the cap, syncing pauses until the next UTC day (the device keeps everything).
      if ((await store.incr(globalReadsKey(now()), 2 * 24 * 3600)) > globalReadsPerDay(env)) return { status: 503, json: { error: READS_PAUSED } };
      return reply(readStoredAttempts(await store.list(keys)));
    }

    if (req.method === "DELETE") {
      // A delete never waits on the global caps (F3) or on the student's own saving: its own small per-user counter only.
      if ((await store.incr(deleteRateKey(userId), 60)) > DELETES_PER_MINUTE) return { status: 429, json: { error: "too many deletes; try again in a minute" } };
    } else {
      if ((await store.incr(rateKey(userId), 60)) > WRITES_PER_MINUTE) return { status: 429, json: { error: "too many writes; try again in a minute" } };
      // Everyone's writes today, together: past the cap, saving is unavailable for all until the next UTC day.
      if ((await store.incr(globalWritesKey(now()), 2 * 24 * 3600)) > GLOBAL_WRITES_PER_DAY) return UNAVAILABLE_RESPONSE;
    }

    const cap = now() + FUTURE_SLACK_MS;
    if (parsed?.ok) {
      const future = new Set(parsed.attempts.filter((a) => Date.parse(a.answeredAt) > cap).map((a) => a.id));
      const result = await store.merge(keys, parsed.attempts.filter((a) => !future.has(a.id)), MAX_ATTEMPTS);
      const merged = readStoredAttempts(result.attempts);
      const over = new Set(result.overLimit);
      // Otherwise not in the account after the merge: at or before the deletion mark. An id the account holds a newer
      // answer for is there, so it counts as synced.
      const held = new Set(merged.map((a) => a.id));
      const refused: Refused[] = [];
      for (const id of new Set(parsed.attempts.map((a) => a.id))) {
        if (future.has(id)) refused.push({ id, reason: "future" });
        else if (over.has(id)) refused.push({ id, reason: "over-limit" });
        else if (!held.has(id)) refused.push({ id, reason: "older-than-delete" });
      }
      return reply(merged, refused);
    }

    const course = new URL(req.url, "http://x").searchParams.get("course");
    if (course) {
      const all = readStoredAttempts(await store.list(keys));
      await store.remove(
        keys,
        all.filter((a) => a.course === course).map((a) => a.id),
      );
      return reply(all.filter((a) => a.course !== course));
    }
    await store.removeAll(keys, DELETED_MARK_TTL_SEC, now());
    return { status: 200, json: { deleted: true } };
  } catch {
    // Unreachable, stopped, slow, corrupt: fail closed. A status tag only, never the request or the records.
    console.error(`account ${req.method}: storage unavailable`);
    return UNAVAILABLE_RESPONSE;
  }
}

const UNAVAILABLE_RESPONSE: AccountResponse = { status: 503, json: { error: UNAVAILABLE } };
