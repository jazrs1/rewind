// Accounts Lite with fake sign-in and the in-memory store: no Clerk, no Upstash, no network.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttemptStore, type StorageLike } from "../attempts/store.ts";
import { createAccountAttemptStore, uploadOf } from "./account-store.ts";
import { accountApi, AccountError, EXPECTED_USER_HEADER } from "./api.ts";
import { resolveUserId, type AuthSources } from "./auth.ts";
import { deviceOwner } from "./device.ts";
import { fakeAuthEnabled, fakeUserId } from "./fake.ts";
import { hasClerkSession } from "./privacy.ts";
import { accountsEnabled } from "./flag.ts";
import { DELETES_PER_MINUTE, GLOBAL_READS_PER_DAY, GLOBAL_WRITES_PER_DAY, globalReadsKey, globalReadsPerDay, globalWritesKey, handleAccountRequest, rateKey, READS_PAUSED, READS_PER_MINUTE, sameOrigin, UNAVAILABLE, userKeys, WRITES_PER_MINUTE } from "./handler.ts";
import { memoryKV, upstashKV } from "./kv.ts";
import { MAX_ATTEMPTS, MAX_BYTES, parseAttemptsBody, toAccountAttempt } from "./schema.ts";
import { apiFor, attempt, body, lookup, ON, record, URL_, write } from "./test-helpers.ts";

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe("schema", () => {
  it("accepts the account fields and nothing else", () => {
    expect(parseAttemptsBody(body([attempt()]))).toEqual({ ok: true, attempts: [attempt()] });
    for (const extra of [{ stem: "Which bucket does key 17 land in?" }, { topic: "7 - Sets" }, { quote: "he said" }, { transcript: "so today" }, { example: false }, { userId: "user_other" }]) {
      const res = parseAttemptsBody(body([{ ...attempt(), ...extra }]));
      expect(res.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("accepts every question id shape the app makes", () => {
    // demo-q1 (older bundles), l20261013-q1 (public/demo/course), q-k3j9x2ab (lib/pipeline/generate.ts), q3 (spike seed),
    // q-code-clip and q-filler-12 (e2e fixture).
    for (const questionId of ["demo-q1", "l20261013-q1", "l20261022-q13", "q-k3j9x2ab", "q3", "q-code-clip", "q-filler-12"]) expect(parseAttemptsBody(body([attempt({ questionId })])).ok, questionId).toBe(true);
    // Every question in the demo bundle fits.
    const bundle = JSON.parse(readFileSync("public/demo/course/course.json", "utf8")) as { sets: { questions: { id: string }[] }[] };
    for (const q of bundle.sets.flatMap((s) => s.questions)) expect(parseAttemptsBody(body([attempt({ questionId: q.id })])).ok, q.id).toBe(true);
    for (const answeredAt of ["2026-10-20T15:00:00Z", "2026-10-20T15:00:00.5Z", "2026-10-20T15:00:00.123Z"]) expect(parseAttemptsBody(body([attempt({ answeredAt })])).ok, answeredAt).toBe(true);
  });

  it("rejects free text in any field (M2)", () => {
    for (const bad of [
      { answeredAt: "hello world 1" },
      { answeredAt: "2026-10-20 15:00:00" },
      { answeredAt: "2026-02-30T15:00:00Z" },
      { answeredAt: "2026-10-20T15:00:00+02:00" },
      { id: `att-${"a".repeat(96)}` },
      { id: "att-0123456789abcdef0123456789abcdef01234" },
      { id: "my notes about trees" },
      { questionId: "Which bucket does key 17 land in?" },
      { questionId: "which-bucket-does-key-seventeen-land-in" },
      { questionId: "q1 the root is 5" },
      { questionId: `q-${"a".repeat(40)}` },
      { course: "Data Structures and Algorithms (Fall)" },
      { choice: "E" },
      { correct: "no" },
      { confidence: "very" },
    ]) {
      expect(parseAttemptsBody(body([attempt(bad as never)])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects other body shapes, oversize bodies and too many attempts", () => {
    expect(parseAttemptsBody("not json").ok).toBe(false);
    expect(parseAttemptsBody(JSON.stringify([attempt()])).ok).toBe(false);
    expect(parseAttemptsBody(JSON.stringify({ attempts: [], userId: "user_other" })).ok).toBe(false);
    expect(parseAttemptsBody(" ".repeat(MAX_BYTES + 1))).toEqual({ ok: false, error: "body too large" });
    const many = Array.from({ length: MAX_ATTEMPTS + 1 }, (_, i) => attempt({ id: `att-${String(i).padStart(8, "0")}` }));
    expect(parseAttemptsBody(body(many)).ok).toBe(false);
  });

  it("strips stem, topic and the example flag before anything leaves the device; examples never leave", () => {
    const out = toAccountAttempt(record(), "COP3530")!;
    expect(out).toEqual(attempt());
    expect(Object.keys(out)).not.toContain("stem");
    expect(Object.keys(out)).not.toContain("topic");
    expect(toAccountAttempt(record({ example: true }), "COP3530")).toBeNull();
    expect(JSON.stringify(uploadOf([record(), record({ id: "att-00000002", example: true })], "COP3530"))).not.toContain("bucket");
  });
});

describe("merge (in-memory store, same rules as the Lua script)", () => {
  it("is by id, keeps the newer record and is idempotent", async () => {
    const kv = memoryKV();
    const old = attempt({ id: "att-0000000a", correct: false, answeredAt: "2026-10-20T15:00:00.000Z" });
    const newer = attempt({ id: "att-0000000a", correct: true, answeredAt: "2026-10-21T15:00:00.000Z" });
    const other = attempt({ id: "att-0000000b" });
    await kv.merge(userKeys("u"), [old], MAX_ATTEMPTS);
    const once = await kv.merge(userKeys("u"), [newer, other], MAX_ATTEMPTS);
    expect(once.attempts.map((a) => [a.id, a.correct])).toEqual([
      ["att-0000000b", false],
      ["att-0000000a", true],
    ]);
    expect(await kv.merge(userKeys("u"), [newer, other], MAX_ATTEMPTS)).toEqual(once);
    expect(await kv.merge(userKeys("u"), [old], MAX_ATTEMPTS)).toEqual(once);
  });

  it("a full account takes no new answers (they come back over the limit), keeps every stored one, and still takes updates", async () => {
    const kv = memoryKV();
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
    const many = Array.from({ length: 60 }, (_, i) => attempt({ id: `att-${String(i).padStart(8, "0")}`, answeredAt: at(i) }));
    const res = await kv.merge(userKeys("u"), many, 50);
    expect(res.attempts.length).toBe(50);
    expect(res.attempts[0].id).toBe("att-00000000");
    expect(res.overLimit).toEqual(many.slice(50).map((a) => a.id));
    // Later: still full. A newer answer is refused; an update to a stored one goes in; nothing is dropped.
    const update = attempt({ id: "att-00000003", correct: true, answeredAt: at(100) });
    const again = await kv.merge(userKeys("u"), [attempt({ id: "att-00000099", answeredAt: at(99) }), update], 50);
    expect(again.overLimit).toEqual(["att-00000099"]);
    expect(again.attempts.length).toBe(50);
    expect(again.attempts.find((a) => a.id === "att-00000003")!.correct).toBe(true);
  });
});

describe("account API", () => {
  it("one user can't read or delete another's data, even with a forged id in the body or query", async () => {
    const kv = memoryKV();
    await apiFor("user_a", kv).post([attempt()]);

    // B asks for A's data by query: B gets B's (empty) list.
    const read = await handleAccountRequest({ method: "GET", url: `${URL_}?userId=user_a&user=user_a` }, "user_b", () => kv, ON);
    expect(read).toEqual({ status: 200, json: { attempts: [], deletedBefore: null, serverTime: expect.any(String) } });
    // B names A in the body: rejected by the schema.
    const forged = await handleAccountRequest(write("POST", URL_, JSON.stringify({ userId: "user_a", attempts: [attempt({ id: "att-0000beef" })] })), "user_b", () => kv, ON);
    expect(forged.status).toBe(400);
    // B deletes with A's id in the query: only B's keys go.
    await handleAccountRequest(write("DELETE", `${URL_}?userId=user_a`), "user_b", () => kv, ON);
    expect((await apiFor("user_a", kv).get()).attempts).toEqual([attempt()]);
    // Signed out: nothing.
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, null, () => kv, ON)).status).toBe(401);
  });

  it("a request for a user other than the session's is refused with 409 and changes nothing (LOW-3)", async () => {
    const kv = memoryKV();
    await apiFor("user_a", kv).post([attempt()]);
    // A tab still on user_a after user_b signed in (cookie now user_b's): every method is refused before storage.
    for (const req of [{ method: "GET", url: URL_ }, write("POST", URL_, body([attempt({ id: "att-0000beef" })])), write("DELETE", URL_)]) {
      expect(await handleAccountRequest({ ...req, expectedUser: "user_a" }, "user_b", () => kv, ON)).toEqual({ status: 409, json: { error: "signed in as someone else" } });
    }
    expect((await apiFor("user_b", kv).get()).attempts).toEqual([]);
    expect((await apiFor("user_a", kv).get()).attempts).toEqual([attempt()]);
    // The same user, or no header (an older page): served.
    expect((await handleAccountRequest({ method: "GET", url: URL_, expectedUser: "user_a" }, "user_a", () => kv, ON)).status).toBe(200);
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, "user_a", () => kv, ON)).status).toBe(200);
  });

  it("the browser's API sends the signed-in user's id with every request, and a 409 rejects", async () => {
    const seen: (string | null)[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get(EXPECTED_USER_HEADER));
      return Response.json({ error: "signed in as someone else" }, { status: 409 });
    }) as typeof fetch;
    const api = accountApi(fetchFn, "user_a");
    await expect(api.get()).rejects.toEqual(new AccountError(409, "signed in as someone else"));
    await expect(api.post([attempt()])).rejects.toBeInstanceOf(AccountError);
    await expect(api.del("COP3530")).rejects.toBeInstanceOf(AccountError);
    expect(seen).toEqual(["user_a", "user_a", "user_a"]);
  });

  it("rejects the bad POSTs from the review (M2)", async () => {
    const kv = memoryKV();
    for (const bad of [{ answeredAt: "hello world 1" }, { id: `att-${"0".repeat(96)}` }, { questionId: "the root is five" }, { questionId: "which-bucket-does-key-seventeen-land-in" }]) {
      const res = await handleAccountRequest(write("POST", URL_, body([attempt(bad)])), "user_a", () => kv, ON);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await apiFor("user_a", kv).get()).attempts).toEqual([]);
  });

  it("refuses writes from another site (Origin must match Host) (L4)", async () => {
    const kv = memoryKV();
    for (const [origin, host] of [
      ["https://evil.example", "rewind.example"],
      [null, "rewind.example"],
      ["null", "rewind.example"],
      ["https://rewind.example.evil.example", "rewind.example"],
    ] as const) {
      for (const method of ["POST", "DELETE"]) {
        const res = await handleAccountRequest({ method, url: URL_, body: body([attempt()]), origin, host }, "user_a", () => kv, ON);
        expect(res.status, `${method} ${origin}`).toBe(403);
      }
    }
    expect((await apiFor("user_a", kv).get()).attempts).toEqual([]);
    expect(sameOrigin("https://rewind.example", "rewind.example")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:3001", "127.0.0.1:3001")).toBe(true);
    // Reads stay plain GETs.
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, "user_a", () => kv, ON)).status).toBe(200);
  });

  it("Delete my data removes every attempt, and the account is empty after", async () => {
    const kv = memoryKV();
    await apiFor("user_a", kv).post([attempt(), attempt({ id: "att-00000002", course: "MAS3114" })]);
    await apiFor("user_b", kv).post([attempt()]);

    const res = await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON);
    expect(res).toEqual({ status: 200, json: { deleted: true } });
    expect(kv.keys()).not.toContain(userKeys("user_a").hash);
    expect((await apiFor("user_a", kv).get()).attempts).toEqual([]);
    expect(((await apiFor("user_b", kv).get()).attempts).length).toBe(1);
  });

  it("Delete my data keeps the rate-limit counter (it expires on its own) (L1), and works with the writes limit used up (F3)", async () => {
    const kv = memoryKV();
    for (let i = 0; i < WRITES_PER_MINUTE; i++) await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_a", () => kv, ON);
    expect((await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON)).status).toBe(200);
    expect(kv.keys()).toContain(rateKey("user_a"));
    expect((await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_a", () => kv, ON)).status).toBe(429);
  });

  it("the deletion mark is the server's time of the delete: re-uploads of deleted answers are refused, later answers go in (L2)", async () => {
    let t = Date.parse("2026-10-21T11:00:00Z");
    const kv = memoryKV(() => t);
    const keep = attempt({ answeredAt: "2026-10-21T11:00:00.000Z" });
    await apiFor("user_a", kv, () => t).post([keep]);
    // The delete, at 12:00 by the server's clock (whatever the deleting device's clock said).
    t = Date.parse("2026-10-21T12:00:00Z");
    await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON, () => t);
    // The other device still has it and syncs: refused. An answer given after the delete still goes in.
    t = Date.parse("2026-10-21T12:01:00Z");
    const later = attempt({ id: "att-00000003", answeredAt: "2026-10-21T12:00:30.000Z" });
    expect(await apiFor("user_a", kv, () => t).post([keep, later])).toEqual({
      attempts: [later],
      refused: [{ id: keep.id, reason: "older-than-delete" }],
      deletedBefore: "2026-10-21T12:00:00.000Z",
      serverTime: "2026-10-21T12:01:00.000Z",
    });
  });

  it("refuses only a record dated more than 5 minutes after the server's time, and lists it (L2)", async () => {
    const now = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => now);
    const ahead = attempt({ id: "att-0000000f", answeredAt: "2026-10-24T22:10:00.000Z" });
    const slack = attempt({ id: "att-00000005", answeredAt: "2026-10-24T22:04:59.000Z" });
    const ok = attempt({ id: "att-00000001", answeredAt: "2026-10-24T21:00:00.000Z" });
    const res = await handleAccountRequest(write("POST", URL_, body([ahead, slack, ok])), "user_a", () => kv, ON, () => now);
    expect(res).toEqual({ status: 200, json: { attempts: [ok, slack], refused: [{ id: ahead.id, reason: "future" }], deletedBefore: null, serverTime: "2026-10-24T22:00:00.000Z" } });
  });

  it("the deletion mark never moves past the server's time, even over an answer stored in the future (L2)", async () => {
    const now = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => now);
    // Stored before this rule existed: dated a year ahead.
    await kv.merge(userKeys("user_a"), [attempt({ id: "att-0000000f", answeredAt: "2027-10-24T22:00:00.000Z" })], MAX_ATTEMPTS);
    await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON, () => now);
    // Another device's real answer, 6 minutes later: goes in.
    const later = Date.parse("2026-10-24T22:06:00Z");
    const real = attempt({ id: "att-00000002", answeredAt: "2026-10-24T22:05:30.000Z" });
    const res = await handleAccountRequest(write("POST", URL_, body([real])), "user_a", () => kv, ON, () => later);
    // The mark is the server's time of the delete (22:00), not a year ahead.
    expect(res).toEqual({ status: 200, json: { attempts: [real], refused: [], deletedBefore: "2026-10-24T22:00:00.000Z", serverTime: "2026-10-24T22:06:00.000Z" } });
  });

  it("gives each refused answer its reason: future, older-than-delete, over-limit", async () => {
    const now = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => now);
    const keys = userKeys("user_a");
    // An account deleted on Oct 21 at 12:00 (server time) that then filled up to the limit.
    await kv.merge(keys, [attempt({ id: "att-000000aa", answeredAt: "2026-10-21T11:30:00.000Z" })], MAX_ATTEMPTS);
    await kv.removeAll(keys, 60, Date.parse("2026-10-21T12:00:00Z"));
    const fill = Array.from({ length: MAX_ATTEMPTS }, (_, i) => attempt({ id: `att-f${String(i).padStart(7, "0")}`, answeredAt: new Date(Date.parse("2026-10-22T00:00:00Z") + i * 1000).toISOString() }));
    await kv.merge(keys, fill, MAX_ATTEMPTS);
    const future = attempt({ id: "att-0000000f", answeredAt: "2026-10-24T22:10:00.000Z" });
    const old = attempt({ id: "att-00000001", answeredAt: "2026-10-21T11:00:00.000Z" });
    const extra = attempt({ id: "att-00000002", answeredAt: "2026-10-24T21:00:00.000Z" });
    const res = await handleAccountRequest(write("POST", URL_, body([future, old, extra])), "user_a", () => kv, ON, () => now);
    expect(res.status).toBe(200);
    expect("attempts" in res.json && res.json.refused).toEqual([
      { id: future.id, reason: "future" },
      { id: old.id, reason: "older-than-delete" },
      { id: extra.id, reason: "over-limit" },
    ]);
  });

  it("a deleting device's fast clock can't swallow another device's later answer (Tier 2 repro 1)", async () => {
    let t = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => t);
    // Device A's clock runs 4 minutes ahead: it syncs an answer it dates 22:04, then deletes (at 22:00 server time).
    await apiFor("user_a", kv, () => t).post([attempt({ id: "att-000000a1", answeredAt: "2026-10-24T22:04:00.000Z" })]);
    await apiFor("user_a", kv, () => t).del();
    // Device B, clock right, answers at 22:01, after the delete: it goes in (a mark at A's 22:04 would have refused it).
    t = Date.parse("2026-10-24T22:02:00Z");
    const b = attempt({ id: "att-000000b1", answeredAt: "2026-10-24T22:01:00.000Z" });
    expect(await apiFor("user_a", kv, () => t).post([b])).toMatchObject({ attempts: [b], refused: [], deletedBefore: "2026-10-24T22:00:00.000Z" });
  });

  it("a global daily cap on everyone's writes: past it, every POST answers 503 storage-unavailable (reads still work)", async () => {
    const now = Date.parse("2026-10-24T22:00:00Z");
    const inner = memoryKV(() => now);
    let globalCount = GLOBAL_WRITES_PER_DAY;
    const kv = { ...inner, incr: async (key: string, ttl: number) => (key === globalWritesKey(now) ? ++globalCount : inner.incr(key, ttl)) };
    expect(globalWritesKey(now)).toBe("rewind:v1:global:writes:2026-10-24");
    expect(await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_new", () => kv, ON, () => now)).toEqual({ status: 503, json: { error: UNAVAILABLE } });
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, "user_new", () => kv, ON, () => now)).status).toBe(200);
    expect((await inner.list(userKeys("user_new"))).length).toBe(0);
  });

  it("with the global write cap used up, Delete my data and a course's clear still work, and don't count against it (F3)", async () => {
    const now = Date.parse("2026-10-24T22:00:00Z");
    const inner = memoryKV(() => now);
    await inner.merge(userKeys("user_a"), [attempt({ id: "att-0000000a", course: "COP3530" }), attempt({ id: "att-0000000b", course: "MAS3114" })], MAX_ATTEMPTS);
    let globalCount = GLOBAL_WRITES_PER_DAY;
    const kv = { ...inner, incr: async (key: string, ttl: number) => (key === globalWritesKey(now) ? ++globalCount : inner.incr(key, ttl)) };
    // Saving is refused for everyone today...
    expect((await handleAccountRequest(write("POST", URL_, body([attempt({ id: "att-0000000c" })])), "user_a", () => kv, ON, () => now)).status).toBe(503);
    const counted = globalCount;
    // ...but a course's clear and Delete my data go through.
    const clear = await handleAccountRequest(write("DELETE", `${URL_}?course=COP3530`), "user_a", () => kv, ON, () => now);
    expect(clear.status).toBe(200);
    expect((await inner.list(userKeys("user_a"))).length).toBe(1);
    expect(await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON, () => now)).toEqual({ status: 200, json: { deleted: true } });
    expect(await inner.list(userKeys("user_a"))).toEqual([]);
    expect(globalCount).toBe(counted);
  });

  it("deletes have their own per-user limit: saving can't use it up, and a burst of deletes is limited", async () => {
    const kv = memoryKV();
    for (let i = 0; i < WRITES_PER_MINUTE + 1; i++) await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_a", () => kv, ON);
    for (let i = 0; i < DELETES_PER_MINUTE; i++) expect((await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON)).status).toBe(200);
    expect((await handleAccountRequest(write("DELETE", URL_), "user_a", () => kv, ON)).status).toBe(429);
  });

  it("a global daily cap on everyone's reads: past it, a GET answers 503 reads-paused; writes and deletes still work", async () => {
    const now = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => now);
    const env = { ...ON, REWIND_ACCOUNT_READS_PER_DAY: "3" };
    expect(globalReadsKey(now)).toBe("rewind:v1:global:reads:2026-10-24");
    for (const user of ["user_a", "user_b", "user_c"]) expect((await handleAccountRequest({ method: "GET", url: URL_ }, user, () => kv, env, () => now)).status).toBe(200);
    expect(await handleAccountRequest({ method: "GET", url: URL_ }, "user_d", () => kv, env, () => now)).toEqual({ status: 503, json: { error: READS_PAUSED } });
    expect((await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_d", () => kv, env, () => now)).status).toBe(200);
    expect((await handleAccountRequest(write("DELETE", URL_), "user_d", () => kv, env, () => now)).status).toBe(200);
    // The next UTC day starts a fresh count.
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, "user_d", () => kv, env, () => now + 24 * 3600_000)).status).toBe(200);
    // Configurable, with a default well under the budget.
    expect(globalReadsPerDay({})).toBe(GLOBAL_READS_PER_DAY);
    expect(globalReadsPerDay({ REWIND_ACCOUNT_READS_PER_DAY: "500" })).toBe(500);
    for (const bad of ["0", "-5", "1.5", "lots", ""]) expect(globalReadsPerDay({ REWIND_ACCOUNT_READS_PER_DAY: bad })).toBe(GLOBAL_READS_PER_DAY);
  });

  it("rate-limits reads per user, and refuses a reply too big to be real", async () => {
    const kv = memoryKV();
    const statuses: number[] = [];
    for (let i = 0; i <= READS_PER_MINUTE; i++) statuses.push((await handleAccountRequest({ method: "GET", url: URL_ }, "user_a", () => kv, ON)).status);
    expect(statuses.slice(0, READS_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    // A store answering with far more than an account can hold: 503, never a huge reply.
    const huge = Array.from({ length: 4000 }, (_, i) => attempt({ id: `att-h${String(i).padStart(7, "0")}` }));
    const bloated = { ...memoryKV(), list: async () => huge };
    expect(await handleAccountRequest({ method: "GET", url: URL_ }, "user_b", () => bloated, ON)).toEqual({ status: 503, json: { error: UNAVAILABLE } });
  });

  it("clearing one course removes only that course", async () => {
    const kv = memoryKV();
    await apiFor("user_a", kv).post([attempt(), attempt({ id: "att-00000002", course: "MAS3114" })]);
    await apiFor("user_a", kv).del("COP3530");
    expect(((await apiFor("user_a", kv).get()).attempts).map((a) => a.course)).toEqual(["MAS3114"]);
  });

  it("rate-limits writes per user", async () => {
    const kv = memoryKV();
    const statuses: number[] = [];
    for (let i = 0; i <= WRITES_PER_MINUTE; i++) statuses.push((await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_a", () => kv, ON)).status);
    expect(statuses.slice(0, WRITES_PER_MINUTE).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect((await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_b", () => kv, ON)).status).toBe(200);
  });

  it("rejects an oversize body with 413 and never logs record contents", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleAccountRequest(write("POST", URL_, " ".repeat(MAX_BYTES + 1)), "user_a", () => memoryKV(), ON);
    expect(res.status).toBe(413);
    const down = memoryKV();
    down.down = true;
    await handleAccountRequest(write("POST", URL_, body([attempt()])), "user_a", () => down, ON);
    expect([...log.mock.calls, ...error.mock.calls].flat().join(" ")).not.toContain("demo-q1");
    log.mockRestore();
    error.mockRestore();
  });

  it("talks to Upstash with the token in a header, the merge and delete-all as one Lua script each", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      // One result per command, as Upstash answers (the store refuses a reply of any other length).
      return new Response(JSON.stringify((JSON.parse(init.body as string) as string[][]).map((c) => ({ result: c[0] === "EVAL" ? [[], []] : "OK" }))));
    }) as unknown as typeof fetch;
    const kv = upstashKV("https://kv.example.invalid/", "tok", fake);
    await kv.merge(userKeys("u"), [attempt()], MAX_ATTEMPTS);
    await kv.removeAll(userKeys("u"), 60, 5_000);
    await kv.remove(userKeys("u"), ["att-00000001"]);
    expect(calls.map((c) => c.url.replace("https://kv.example.invalid/", ""))).toEqual(["pipeline", "pipeline", "multi-exec"]);
    expect((calls[0].body as unknown[][])[0].slice(0, 1)).toEqual(["EVAL"]);
    expect((calls[1].body as unknown[][])[0]).toEqual(["EVAL", expect.stringContaining("'SET', KEYS[3], mark"), 3, userKeys("u").hash, userKeys("u").byTime, userKeys("u").deletedMark, 60, 5_000]);
    expect((calls[1].body as unknown[][])[0][1]).not.toContain("ZRANGE");
  });
});

describe("store down (Upstash budget cap reached, or unreachable): fail closed", () => {
  it("every call answers 503 'Saving is unavailable right now', and nothing is half-written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = memoryKV();
    await apiFor("user_a", kv).post([attempt()]);
    kv.down = true;
    for (const req of [{ method: "GET", url: URL_ }, write("POST", URL_, body([attempt({ id: "att-00000002" })])), write("DELETE", URL_)]) {
      expect(await handleAccountRequest(req, "user_a", () => kv, ON)).toEqual({ status: 503, json: { error: UNAVAILABLE } });
    }
    // Not set up at all: the same answer.
    expect(await handleAccountRequest({ method: "GET", url: URL_ }, "user_a", () => null, ON)).toEqual({ status: 503, json: { error: UNAVAILABLE } });
    // An Upstash error (a stopped database answers with an error) is the same.
    const stopped = upstashKV("https://kv.example.invalid", "tok", (async () => new Response(JSON.stringify({ error: "database is stopped" }), { status: 400 })) as unknown as typeof fetch);
    expect((await handleAccountRequest({ method: "GET", url: URL_ }, "user_a", () => stopped, ON)).status).toBe(503);
    kv.down = false;
    expect((await apiFor("user_a", kv).get()).attempts).toEqual([attempt()]);
    vi.restoreAllMocks();
  });

  it("the browser keeps practising on the device and catches up when the store is back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = memoryKV();
    kv.down = true;
    const storage = new MemoryStorage();
    const local = createAttemptStore({ course: "COP3530", storage: () => storage });
    const errors: unknown[] = [];
    const store = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local, owner: deviceOwner("COP3530", () => storage), api: apiFor("user_a", kv), lookup, onError: (e) => errors.push(e) });
    await expect(store.sync()).rejects.toThrow("503");
    store.add({ questionId: "demo-q1", topic: "t", stem: "s", choice: "B", correct: false, confidence: null, answeredAt: "2026-10-20T15:00:00.000Z" });
    await vi.waitFor(() => expect(errors.length).toBe(1));
    expect(local.list().length).toBe(1);
    kv.down = false;
    await store.sync();
    expect(((await apiFor("user_a", kv).get()).attempts).length).toBe(1);
    vi.restoreAllMocks();
  });
});

describe("Clerk loads only when needed", () => {
  it("hasClerkSession: only a real Clerk session cookie counts", () => {
    expect(hasClerkSession("")).toBe(false);
    expect(hasClerkSession("theme=dark; rewind-fake-user=fake_abc")).toBe(false);
    expect(hasClerkSession("__client_uat=0")).toBe(false);
    expect(hasClerkSession("__client_uat_AbC12=0; other=1")).toBe(false);
    expect(hasClerkSession("__client_uat=1729800000")).toBe(true);
    expect(hasClerkSession("x=1; __client_uat_AbC12=1729800000")).toBe(true);
    expect(hasClerkSession("__session=eyJhbGciOi")).toBe(true);
  });
});

describe("fake sign-in", () => {
  const sources = (cookie: string | undefined): AuthSources & { clerkCalls: number } => {
    const s = {
      clerkCalls: 0,
      fakeCookie: async () => cookie,
      clerk: async () => {
        s.clerkCalls += 1;
        return null;
      },
    };
    return s;
  };

  it("works only with REWIND_FAKE_AUTH=1 outside production", async () => {
    expect(fakeAuthEnabled({ REWIND_FAKE_AUTH: "1", NODE_ENV: "development" })).toBe(true);
    expect(fakeAuthEnabled({ REWIND_FAKE_AUTH: "1", NODE_ENV: "test" })).toBe(true);
    expect(fakeAuthEnabled({ REWIND_FAKE_AUTH: "1", NODE_ENV: "production" })).toBe(false);
    expect(fakeAuthEnabled({ REWIND_FAKE_AUTH: "1", NODE_ENV: "development", VERCEL: "1" })).toBe(false);
    expect(fakeAuthEnabled({ REWIND_FAKE_AUTH: "true", NODE_ENV: "development" })).toBe(false);
    expect(fakeAuthEnabled({ NODE_ENV: "development" })).toBe(false);

    const id = fakeUserId("Student@ufl.edu ");
    expect(id).toBe(fakeUserId("student@ufl.edu"));
    expect(await resolveUserId(sources(id), { REWIND_FAKE_AUTH: "1", NODE_ENV: "development" })).toBe(id);
    expect(await resolveUserId(sources("user_real"), { REWIND_FAKE_AUTH: "1", NODE_ENV: "development" })).toBeNull();
  });

  it("can't be turned on in a production build: the cookie is ignored and Clerk decides", async () => {
    const s = sources(fakeUserId("student@ufl.edu"));
    expect(await resolveUserId(s, { REWIND_FAKE_AUTH: "1", NODE_ENV: "production" })).toBeNull();
    expect(s.clerkCalls).toBe(1);
  });

  it("a production build's server has NODE_ENV=production baked in", () => {
    // next build and next start run with NODE_ENV=production; the fake checks it at request time.
    const src = readFileSync("lib/accounts/fake.ts", "utf8");
    expect(src).toMatch(/env\.NODE_ENV !== "production"/);
  });
});

describe("with the flag off", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("@clerk/nextjs/server");
  });

  it("the API answers 404 without reading the session or the store", async () => {
    const kv = vi.fn(() => memoryKV());
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await handleAccountRequest({ method, url: URL_, body: body([attempt()]) }, "user_a", kv, {});
      expect(res.status).toBe(404);
    }
    expect(kv).not.toHaveBeenCalled();
    expect(accountsEnabled({})).toBe(false);
    expect(accountsEnabled({ NEXT_PUBLIC_REWIND_ACCOUNTS: "true" })).toBe(false);
  });

  it("the proxy passes every request through and never loads Clerk", async () => {
    vi.stubEnv("NEXT_PUBLIC_REWIND_ACCOUNTS", "");
    const loaded = vi.fn();
    vi.doMock("@clerk/nextjs/server", () => {
      loaded();
      return { clerkMiddleware: () => () => new Response("clerk") };
    });
    const { proxy } = await import("../../proxy.ts");
    const { NextRequest } = await import("next/server");
    const res = await proxy(new NextRequest("http://localhost/api/account/attempts"), {} as never);
    expect(res?.headers.get("x-middleware-next")).toBe("1");
    expect(loaded).not.toHaveBeenCalled();
  });

  it("the screens use this device's store, and the account entry renders nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_REWIND_ACCOUNTS", "");
    const { attemptStore, browserAttemptStore } = await import("../attempts/store.ts");
    expect(attemptStore("COP3530")).toBe(browserAttemptStore("COP3530"));
    const { AccountEntry } = await import("../../components/accounts/AccountEntry.tsx");
    expect(AccountEntry({ course: "COP3530", questions: [], fake: false })).toBeNull();
  });

  it("no account package is imported outside the lazy chunks", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !name.includes(".test.")) files.push(p);
      }
    };
    for (const dir of ["app", "components", "lib"]) walk(dir);
    files.push("proxy.ts");
    const statics = files.filter((f) => /^\s*import\s[^;]*from\s+["']@clerk\//m.test(readFileSync(f, "utf8")));
    // Only the Clerk sign-in component, which is itself only ever loaded with import().
    expect(statics).toEqual([join("components", "accounts", "ClerkAccount.tsx")]);
    const importers = files.filter((f) => readFileSync(f, "utf8").includes("ClerkAccount"));
    for (const f of importers.filter((f) => !f.endsWith("ClerkAccount.tsx"))) expect(readFileSync(f, "utf8")).not.toMatch(/^\s*import\s[^;]*ClerkAccount/m);
    // The menu itself is only reachable through the flag.
    expect(readFileSync("components/accounts/AccountEntry.tsx", "utf8")).toMatch(/ACCOUNTS_ON \? dynamic\(\(\) => import\("\.\/AccountMenu"\)/);
  });
});
