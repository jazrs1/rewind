// Which store the account routes use: the in-memory fake while fake sign-in is on (tests; never in
// production), else Upstash from KV_REST_API_URL / KV_REST_API_TOKEN, else none (the routes answer 503).

import { fakeAuthEnabled } from "./fake.ts";
import { memoryKV, upstashKV, type AccountKV } from "./kv.ts";

type Env = Record<string, string | undefined>;

// One fake store per dev server process, kept across module reloads.
const shared = globalThis as { __rewindFakeKV?: AccountKV };

export function accountKV(env: Env = process.env): AccountKV | null {
  if (fakeAuthEnabled(env)) return (shared.__rewindFakeKV ??= memoryKV());
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  return url && token ? upstashKV(url, token) : null;
}
