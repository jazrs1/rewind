// Shared fixtures for the account tests: invented records, and the account API as one user sees it,
// run through the real handler with that user's verified id and the in-memory store. No network.

import type { AttemptRecord } from "../attempts/store.ts";
import type { AccountApi } from "./account-store.ts";
import { handleAccountRequest, type AccountRequest } from "./handler.ts";
import type { AccountKV } from "./kv.ts";
import type { AccountAttempt } from "./schema.ts";

export const ON = { NEXT_PUBLIC_REWIND_ACCOUNTS: "1" };
export const URL_ = "http://rewind.test/api/account/attempts";

export const attempt = (over: Partial<AccountAttempt> = {}): AccountAttempt => ({
  id: "att-00000001",
  questionId: "demo-q1",
  course: "COP3530",
  choice: "B",
  correct: false,
  confidence: "guessing",
  answeredAt: "2026-10-20T15:00:00.000Z",
  ...over,
});

export const record = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  id: "att-00000001",
  questionId: "demo-q1",
  topic: "7 - Sets, Maps, HashTables",
  stem: "Which bucket does key 17 land in?",
  choice: "B",
  correct: false,
  confidence: "guessing",
  answeredAt: "2026-10-20T15:00:00.000Z",
  example: false,
  ...over,
});

export const body = (attempts: unknown[]) => JSON.stringify({ attempts });

/** A write from this site (Origin matches Host). */
export const write = (method: string, url: string, b?: string): AccountRequest => ({ method, url, body: b, origin: "http://rewind.test", host: "rewind.test" });

export const lookup = (id: string) =>
  id === "demo-q1" ? { topic: "7 - Sets, Maps, HashTables", stem: "Which bucket does key 17 land in?" } : id === "demo-q2" ? { topic: "8 - Trees", stem: "Which node is the root?" } : null;

/** The API as one user sees it: every call goes through the real handler with that user's verified id. */
export function apiFor(userId: string, kv: AccountKV, now: () => number = Date.now): AccountApi {
  const call = async (method: string, url: string, b?: string) => {
    const res = await handleAccountRequest(method === "GET" ? { method, url } : write(method, url, b), userId, () => kv, ON, now);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    return "attempts" in res.json
      ? { attempts: res.json.attempts, refused: res.json.refused ?? [], deletedBefore: res.json.deletedBefore, serverTime: res.json.serverTime }
      : { attempts: [], refused: [], deletedBefore: null, serverTime: new Date(now()).toISOString() };
  };
  return {
    get: async () => {
      const r = await call("GET", URL_);
      return { attempts: r.attempts, deletedBefore: r.deletedBefore, serverTime: r.serverTime };
    },
    post: (a) => call("POST", URL_, body(a)),
    del: async (course) => void (await call("DELETE", course ? `${URL_}?course=${course}` : URL_)),
  };
}
