// The browser's side of the account API (app/api/account/attempts). Same-origin requests: the session
// travels in its cookie, never in the body or the URL.

import type { AccountApi } from "./account-store.ts";
import type { Refused } from "./handler.ts";
import type { AccountAttempt } from "./schema.ts";

const URL_BASE = "/api/account/attempts";

export class AccountError extends Error {
  readonly status: number;
  /** The server's error code ("storage-unavailable"), when it sent one. */
  readonly code: string | null;
  constructor(status: number, code: string | null = null) {
    super(`account request failed (${status})`);
    this.status = status;
    this.code = code;
  }
}

/** The account's storage can't be used right now (stopped, unreachable, slow): practice stays on this device. */
export const isStorageDown = (e: unknown): boolean => e instanceof AccountError && (e.status === 503 || e.code === "storage-unavailable");
/** Everyone's reads for today are used up (handler.ts READS_PAUSED): syncing pauses until the next UTC day. */
export const isReadsPaused = (e: unknown): boolean => e instanceof AccountError && e.code === "reads-paused";

/** How long one account request may take; after that it counts as failed (and changes nothing). */
export const REQUEST_TIMEOUT_MS = 15_000;

/** A reply that isn't the whole of what was asked for. The sync treats it like any failure: nothing on the device changes. */
export class BadReply extends Error {
  constructor(why: string) {
    super(`account reply was incomplete (${why})`);
    this.name = "BadReply";
  }
}

/** Who this page thinks is signed in: the server refuses (409) a request whose session is someone else (a stale tab). */
export const EXPECTED_USER_HEADER = "x-rewind-user";

async function call(path: string, init: RequestInit, fetchFn: typeof fetch, expectedUser?: string): Promise<Record<string, unknown>> {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(expectedUser ? { [EXPECTED_USER_HEADER]: expectedUser } : {}) };
  const res = await fetchFn(path, { ...init, headers, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) {
    const code = await res.json().then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error : null)).catch(() => null);
    throw new AccountError(res.status, code);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BadReply("not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadReply("not an object");
  return body as Record<string, unknown>;
}

const REASONS = new Set(["future", "older-than-delete", "over-limit"]);
const isRefused = (r: unknown): r is Refused => !!r && typeof r === "object" && typeof (r as Refused).id === "string" && REASONS.has((r as Refused).reason);
const isRecord = (a: unknown): a is AccountAttempt => !!a && typeof a === "object" && typeof (a as AccountAttempt).id === "string" && typeof (a as AccountAttempt).answeredAt === "string";

/** The parts every read and merge reply must have, whole: the account's records, its deletion mark and the server's time. */
function accountOf(body: Record<string, unknown>): { attempts: AccountAttempt[]; deletedBefore: string | null; serverTime: string } {
  if (!Array.isArray(body.attempts) || !body.attempts.every(isRecord)) throw new BadReply("attempts");
  const mark = body.deletedBefore;
  if (mark !== null && (typeof mark !== "string" || Number.isNaN(Date.parse(mark)))) throw new BadReply("deletedBefore");
  if (typeof body.serverTime !== "string" || Number.isNaN(Date.parse(body.serverTime))) throw new BadReply("serverTime");
  return { attempts: body.attempts, deletedBefore: mark, serverTime: body.serverTime };
}

/** `expectedUser`: the user this page's account store is for (sent with every request, checked by the server). */
export function accountApi(fetchFn: typeof fetch = (...a) => fetch(...a), expectedUser?: string): AccountApi {
  return {
    async get() {
      return accountOf(await call(URL_BASE, { method: "GET" }, fetchFn, expectedUser));
    },
    async post(attempts) {
      const body = await call(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attempts }) }, fetchFn, expectedUser);
      if (!Array.isArray(body.refused) || !body.refused.every(isRefused)) throw new BadReply("refused");
      return { ...accountOf(body), refused: body.refused };
    },
    async del(course) {
      await call(course ? `${URL_BASE}?course=${encodeURIComponent(course)}` : URL_BASE, { method: "DELETE" }, fetchFn, expectedUser);
    },
  };
}
