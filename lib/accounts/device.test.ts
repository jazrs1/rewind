// A shared browser (M1): one student's answers never reach the next student's account, and leave the
// device when they sign out. Fake sign-in ids, the in-memory store and in-memory localStorage.
import { describe, expect, it, vi } from "vitest";
import { createAttemptStore, type NewAttempt, type StorageLike } from "../attempts/store.ts";
import { BATCH_ATTEMPTS, BATCH_BYTES, createAccountAttemptStore, firstBatch, releaseDevice, type AccountStore } from "./account-store.ts";
import { accountApi } from "./api.ts";
import { deviceOwner } from "./device.ts";
import { memoryKV } from "./kv.ts";
import { userKeys } from "./handler.ts";
import { MAX_ATTEMPTS, MAX_BYTES, type AccountAttempt } from "./schema.ts";
import { apiFor, attempt, lookup, record } from "./test-helpers.ts";

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

const answer = (questionId: string, answeredAt: string, over: Partial<NewAttempt> = {}): NewAttempt => ({ questionId, topic: "t", stem: "s", choice: "B", correct: false, confidence: null, answeredAt, ...over });

/** One browser: its localStorage, the attempt store on it, and the account menu's sign-in and sign-out steps. */
function browser(kv = memoryKV()) {
  const storage = new MemoryStorage();
  const local = createAttemptStore({ course: "COP3530", storage: () => storage });
  const owner = deviceOwner("COP3530", () => storage);
  let store: AccountStore | null = null;
  return {
    kv,
    local,
    owner,
    /** The menu's effect for a new user: the old store is disposed, the new one syncs. */
    signIn: async (userId: string, api = apiFor(userId, kv)) => {
      store?.dispose();
      store = createAccountAttemptStore({ course: "COP3530", userId, local, owner, api, lookup });
      await store.sync();
      return store;
    },
    /** What the menu does: one last sync, then (signed out) the account's attempts leave the device. */
    signOut: async () => {
      await store?.flush();
      store?.dispose();
      store = null;
      releaseDevice(local, owner);
    },
    /** The session ended without the button (expired, signed out in another tab): the menu sees signed-out. */
    sessionEnds: () => {
      store?.dispose();
      store = null;
      releaseDevice(local, owner);
    },
    answer: (a: NewAttempt) => (store ?? local).add(a),
  };
}

const questions = (kvList: { questionId: string }[]) => kvList.map((a) => a.questionId).sort();

describe("a shared device", () => {
  it("A signs in, answers and signs out; B signs in on the same browser: B's account gets none of A's answers, and A's are gone from the device", async () => {
    const b = browser();
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    b.answer(answer("demo-q2", "2026-10-20T15:01:00.000Z"));
    await b.signOut();
    expect(questions((await apiFor("user_a", b.kv).get()).attempts)).toEqual(["demo-q1", "demo-q2"]);
    expect(b.local.list()).toEqual([]);

    await b.signIn("user_b");
    expect((await apiFor("user_b", b.kv).get()).attempts).toEqual([]);
    expect(b.local.list()).toEqual([]);
  });

  it("answers given signed out after A signed out do merge into B", async () => {
    const b = browser();
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await b.signOut();

    b.answer(answer("demo-q3", "2026-10-20T16:00:00.000Z"));
    await b.signIn("user_b");
    expect(questions((await apiFor("user_b", b.kv).get()).attempts)).toEqual(["demo-q3"]);
    expect(questions((await apiFor("user_a", b.kv).get()).attempts)).toEqual(["demo-q1"]);
    expect(questions(b.local.list())).toEqual(["demo-q3"]);
  });

  it("A's session ends without the button, and the next student signs in: A's answers are never sent to B", async () => {
    const b = browser();
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 0));
    b.sessionEnds();
    expect(b.local.list()).toEqual([]);
    await b.signIn("user_b");
    expect((await apiFor("user_b", b.kv).get()).attempts).toEqual([]);
  });

  it("even if A's attempts were somehow still on the device (no sign-out ran), signing in as B drops them unsent", async () => {
    const b = browser();
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 0));
    // No sign-out, no session-end: straight to B (a crash, a closed tab).
    await b.signIn("user_b");
    expect((await apiFor("user_b", b.kv).get()).attempts).toEqual([]);
    expect(b.local.list()).toEqual([]);
    expect(b.owner.owner()).toBe("user_b");
  });

  it("A signing back in on the same device gets their answers back", async () => {
    const b = browser();
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await b.signOut();
    await b.signIn("user_a");
    expect(questions(b.local.list())).toEqual(["demo-q1"]);
  });

  it("first sign-in moves this device's real attempts in, drops examples, and signing in twice duplicates nothing", async () => {
    const b = browser();
    b.local.seedExamples([answer("demo-q2", "2026-10-19T15:00:00.000Z")]);
    expect(b.local.list()[0].example).toBe(true);
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await b.signIn("user_a");
    const first = (await apiFor("user_a", b.kv).get()).attempts;
    expect(questions(first)).toEqual(["demo-q1"]);
    expect(JSON.stringify(first)).not.toMatch(/example|topic|stem/);
    for (let i = 0; i < 2; i++) await b.signIn("user_a");
    expect((await apiFor("user_a", b.kv).get()).attempts).toEqual(first);
    expect(b.local.list().length).toBe(1);
  });

  it("a new device gets the account's attempts back with their topic and stem from the bundle", async () => {
    const kv = memoryKV();
    const one = browser(kv);
    await one.signIn("user_a");
    one.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await one.signOut();

    const two = browser(kv);
    two.local.seedExamples([answer("demo-q2", "2026-10-19T15:00:00.000Z")]);
    await two.signIn("user_a");
    expect(two.local.list()).toEqual([expect.objectContaining({ questionId: "demo-q1", topic: "7 - Sets, Maps, HashTables", stem: "Which bucket does key 17 land in?", example: false })]);
  });

  it("no sync runs while Delete my data is in flight, and an answer given meanwhile survives it", async () => {
    // A fixed server clock (F2): the delete's mark is exactly T, and the answer given during it is dated a minute later.
    // With the real clock, an answer stamped in the same millisecond as the mark is rightly held as older-than-delete.
    const T = Date.parse("2026-10-21T12:00:00.000Z");
    const kv = memoryKV(() => T);
    const b = browser(kv);
    const api = apiFor("user_a", kv, () => T);
    const store = await b.signIn("user_a", api);
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    // Let the answer's own sync finish before watching for syncs.
    await store.sync();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realRemoveAll = kv.removeAll.bind(kv);
    const posts: number[] = [];
    const realMerge = kv.merge.bind(kv);
    kv.merge = async (...args) => {
      posts.push(args[1].length);
      return realMerge(...args);
    };
    kv.removeAll = async (...args) => {
      await gate;
      return realRemoveAll(...args);
    };
    const deleting = store.deleteAll();
    await new Promise((r) => setTimeout(r, 0));
    // A sync now does nothing; an answer now stays on the device.
    await store.sync();
    b.answer(answer("demo-q2", new Date(T + 60_000).toISOString()));
    expect(posts).toEqual([]);
    release();
    await deleting;
    expect(questions(b.local.list())).toEqual(["demo-q2"]);
    // The answer given during the delete is sent once it's done.
    await vi.waitFor(async () => expect(questions((await api.get()).attempts)).toEqual(["demo-q2"]), { timeout: 5000 });
  });

  it("a stale store's sync still in flight when the user changes touches nothing (M1 residual)", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    // A is signed in and answers; the server stores it, but A's response is held back.
    let respond!: () => void;
    const held = new Promise<void>((r) => (respond = r));
    const realA = apiFor("user_a", kv);
    const slowA = {
      ...realA,
      post: async (x: Parameters<typeof realA.post>[0]) => {
        const res = await realA.post(x);
        await held;
        return res;
      },
    };
    const a = await b.signIn("user_a", slowA);
    a.add(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 0));

    // The session switches to B (the menu disposes A's store; B's takes over), then A's response arrives.
    await b.signIn("user_b");
    respond();
    await new Promise((r) => setTimeout(r, 10));

    expect(b.local.list()).toEqual([]);
    expect((await apiFor("user_b", kv).get()).attempts).toEqual([]);
    expect(b.owner.owner()).toBe("user_b");
    // B answers and syncs: still nothing of A's goes to B.
    b.answer(answer("demo-q2", "2026-10-20T16:00:00.000Z"));
    await vi.waitFor(async () => expect(questions((await apiFor("user_b", kv).get()).attempts)).toEqual(["demo-q2"]));
    expect(questions((await apiFor("user_a", kv).get()).attempts)).toEqual(["demo-q1"]);
  });

  it("an old store can't claim the device back: owner.claim refuses another user", () => {
    const b = browser();
    expect(b.owner.claim("user_b", ["att-00000001"])).toBe(true);
    expect(b.owner.claim("user_a", ["att-00000002"])).toBe(false);
    expect(b.owner.owner()).toBe("user_b");
    expect(b.owner.owned()).toEqual(["att-00000001"]);
  });

  it("an answer the server refuses for its time stays on the device after sign-out, and goes in once it can (L2)", async () => {
    let t = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => t);
    const b = browser(kv);
    const api = apiFor("user_a", kv, () => t);
    await b.signIn("user_a", api);
    // This device's clock is 10 minutes ahead: the server refuses that one, keeps the other.
    b.answer(answer("demo-q1", "2026-10-24T22:10:00.000Z"));
    b.answer(answer("demo-q2", "2026-10-24T21:59:00.000Z"));
    await vi.waitFor(async () => expect(questions((await apiFor("user_a", kv, () => t).get()).attempts)).toEqual(["demo-q2"]));
    await b.signOut();
    // The refused one is still here (never marked synced); the synced one left with the sign-out.
    expect(questions(b.local.list())).toEqual(["demo-q1"]);
    // Later, A signs in again once the server's time has caught up: it goes in.
    t = Date.parse("2026-10-24T22:06:00Z");
    await b.signIn("user_a", apiFor("user_a", kv, () => t));
    expect(questions((await apiFor("user_a", kv, () => t).get()).attempts)).toEqual(["demo-q1", "demo-q2"]);
  });

  it("a session that ends offline keeps the answers that never synced; the next student gets none of them", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    await b.signIn("user_a");
    kv.down = true;
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 0));
    b.sessionEnds();
    // Never confirmed by the server, so it isn't released.
    expect(questions(b.local.list())).toEqual(["demo-q1"]);
    kv.down = false;
    // A comes back: it syncs.
    await b.signIn("user_a");
    expect(questions((await apiFor("user_a", kv).get()).attempts)).toEqual(["demo-q1"]);

    // Again offline, then a different student signs in: A's unsynced answer leaves the device unsent.
    kv.down = true;
    b.answer(answer("demo-q2", "2026-10-20T16:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 0));
    b.sessionEnds();
    kv.down = false;
    await b.signIn("user_b");
    expect((await apiFor("user_b", kv).get()).attempts).toEqual([]);
    expect(b.local.list()).toEqual([]);
  });

  it("an unsynced answer the server refuses as older than a Delete my data stays on the device and isn't sent again (it may be real work)", async () => {
    let t = Date.parse("2026-10-21T11:00:00Z");
    const kv = memoryKV(() => t);
    // Another device deletes A's data at 12:00 by the server's clock.
    await apiFor("user_a", kv, () => t).post([attempt({ id: "att-000000aa", answeredAt: "2026-10-21T10:00:00.000Z" })]);
    t = Date.parse("2026-10-21T12:00:00Z");
    await apiFor("user_a", kv, () => t).del();
    t = Date.parse("2026-10-21T13:00:00Z");

    // This device (its clock behind, or offline through the delete) has an unsynced answer dated before it, and a newer one.
    const b = browser(kv);
    const posts: string[][] = [];
    const real = apiFor("user_a", kv, () => t);
    const watched = { ...real, post: (x: Parameters<typeof real.post>[0]) => (posts.push(x.map((a) => a.id)), real.post(x)) };
    await b.signIn("user_a", watched);
    const old = b.answer(answer("demo-q1", "2026-10-21T11:30:00.000Z"));
    const fresh = b.answer(answer("demo-q2", "2026-10-21T12:30:00.000Z"));
    await vi.waitFor(async () => expect(questions((await real.get()).attempts)).toEqual(["demo-q2"]));
    await vi.waitFor(() => expect(b.owner.held("user_a", "stale")).toEqual([old.id]));
    // Kept on the device (never confirmed, so never dropped), the new one synced.
    expect(b.local.list().map((r) => r.id).sort()).toEqual([old.id, fresh.id].sort());
    expect(b.owner.held("user_a", "full")).toEqual([]);

    // The next syncs never send it again.
    const sentBefore = posts.length;
    b.answer(answer("demo-q3", "2026-10-21T12:45:00.000Z"));
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(sentBefore));
    expect(posts.slice(sentBefore).flat()).not.toContain(old.id);
  });

  it("an answer refused because the account is full stays on the device, isn't sent again, and the menu hears about it", async () => {
    const kv = memoryKV();
    // A's account already holds its 2,000.
    const fill = Array.from({ length: MAX_ATTEMPTS }, (_, i) => attempt({ id: `att-f${String(i).padStart(7, "0")}`, answeredAt: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 1000).toISOString() }));
    await kv.merge(userKeys("user_a"), fill, MAX_ATTEMPTS);

    const b = browser(kv);
    const posts: string[][] = [];
    const real = apiFor("user_a", kv);
    const watched = { ...real, post: (x: Parameters<typeof real.post>[0]) => (posts.push(x.map((a) => a.id)), real.post(x)) };
    const full: number[] = [];
    const store = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local: b.local, owner: b.owner, api: watched, lookup, onState: (d) => full.push(d.full) });
    await store.sync();
    expect(full.at(-1)).toBe(0);

    const kept = store.add(answer("demo-q1", "2026-10-24T21:00:00.000Z"));
    await vi.waitFor(() => expect(full.at(-1)).toBe(1));
    // On the device, not in the account.
    expect(b.local.list().map((r) => r.id)).toContain(kept.id);
    expect(((await real.get()).attempts).map((a) => a.id)).not.toContain(kept.id);

    // The next syncs never send it again.
    const before = posts.length;
    store.add(answer("demo-q2", "2026-10-24T21:05:00.000Z"));
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.slice(before).flat()).not.toContain(kept.id);
    // Signing out keeps it (it was never confirmed); a delete empties the account and the note goes.
    store.dispose();
    b.sessionEnds();
    expect(b.local.list().map((r) => r.id)).toContain(kept.id);
    const again = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local: b.local, owner: b.owner, api: real, lookup, onState: (d) => full.push(d.full) });
    await again.deleteAll();
    expect(full.at(-1)).toBe(0);
  });

  it("answers kept because the account was full are sent once there's room again (LOW-2b)", async () => {
    const kv = memoryKV();
    const fill = Array.from({ length: MAX_ATTEMPTS }, (_, i) => attempt({ id: `att-f${String(i).padStart(7, "0")}`, answeredAt: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 1000).toISOString() }));
    await kv.merge(userKeys("user_a"), fill, MAX_ATTEMPTS);
    const b = browser(kv);
    const real = apiFor("user_a", kv);
    const states: { full: number }[] = [];
    const store = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local: b.local, owner: b.owner, api: real, lookup, onState: (d) => states.push(d) });
    await store.sync();
    const one = store.add(answer("demo-q1", "2026-10-24T21:00:00.000Z"));
    const two = store.add(answer("demo-q2", "2026-10-24T21:05:00.000Z"));
    await vi.waitFor(() => expect(b.owner.held("user_a", "full").sort()).toEqual([one.id, two.id].sort()));
    // Still full: a sync leaves them held.
    await store.sync();
    expect(b.owner.held("user_a", "full")).toHaveLength(2);

    // One place frees up (removed on another device): one of them is saved, the other is kept again.
    await kv.remove(userKeys("user_a"), [fill[0].id]);
    await store.sync();
    await vi.waitFor(async () => expect(((await real.get()).attempts).filter((a) => a.id === one.id || a.id === two.id)).toHaveLength(1));
    await vi.waitFor(() => expect(b.owner.held("user_a", "full")).toHaveLength(1));
    expect(states.at(-1)?.full).toBe(1);

    // More room: the last one goes in, and the note goes.
    await kv.remove(userKeys("user_a"), [fill[1].id]);
    await store.sync();
    await vi.waitFor(async () => expect(((await real.get()).attempts).map((a) => a.id)).toEqual(expect.arrayContaining([one.id, two.id])));
    await vi.waitFor(() => expect(states.at(-1)?.full).toBe(0));
    expect(b.owner.held("user_a")).toEqual([]);
  });

  it("the menu hears how many answers aren't saved yet and how many predate a delete (LOW-1, MED-1)", async () => {
    let t = Date.parse("2026-10-21T12:00:00.000Z");
    const kv = memoryKV();
    const b = browser(kv);
    await apiFor("user_a", kv, () => t).del();
    t = Date.parse("2026-10-21T13:00:00.000Z");
    const states: { full: number; stale: number; unsynced: number }[] = [];
    let down = true;
    const real = apiFor("user_a", kv, () => t);
    const flaky = {
      ...real,
      get: () => (down ? Promise.reject(new Error("down")) : real.get()),
      post: (x: Parameters<typeof real.post>[0]) => (down ? Promise.reject(new Error("down")) : real.post(x)),
    };
    const store = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local: b.local, owner: b.owner, api: flaky, lookup, onError: () => {}, onState: (d) => states.push(d) });
    // Offline: both count as not saved yet.
    store.add(answer("demo-q1", "2026-10-21T11:30:00.000Z"));
    store.add(answer("demo-q2", "2026-10-21T12:30:00.000Z"));
    expect(states.at(-1)).toEqual({ full: 0, stale: 0, unsynced: 2 });
    // Back: the newer one is saved; the one dated before the delete is kept and counted.
    down = false;
    // (Retried until the sync that was running while offline has settled.)
    await vi.waitFor(() => store.sync());
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ full: 0, stale: 1, unsynced: 1 }));
  });

  it("a course cleared on the device but not in the account tells the menu (LOW-4)", async () => {
    const b = browser(memoryKV());
    const real = apiFor("user_a", b.kv);
    let failed = 0;
    const store = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local: b.local, owner: b.owner, api: { ...real, del: () => Promise.reject(new Error("down")) }, lookup, onError: () => {}, onClearFailed: () => failed++ });
    store.clear();
    await vi.waitFor(() => expect(failed).toBe(1));
    const ok = createAccountAttemptStore({ course: "COP3530", userId: "user_a", local: b.local, owner: b.owner, api: real, lookup, onClearFailed: () => failed++ });
    ok.clear();
    await new Promise((r) => setTimeout(r, 20));
    expect(failed).toBe(1);
  });

  it("a backlog of 3,000 unsynced answers goes over several requests, each under 2,000 answers and 256 KB (F1)", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    // Answered signed out on this device (offline for weeks, say): 3,000 of them.
    const backlog = Array.from({ length: 3000 }, (_, i) =>
      record({ id: `att-b${String(i).padStart(7, "0")}`, answeredAt: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 60_000).toISOString() }),
    );
    b.local.merge(backlog);
    const real = apiFor("user_a", kv);
    const posts: { count: number; bytes: number }[] = [];
    const watched = {
      ...real,
      post: (x: Parameters<typeof real.post>[0]) => {
        posts.push({ count: x.length, bytes: new TextEncoder().encode(JSON.stringify({ attempts: x })).length });
        return real.post(x);
      },
    };
    await b.signIn("user_a", watched);

    // Every request fits the server's limits (none is refused as too big), and it took several.
    expect(posts.length).toBeGreaterThanOrEqual(6);
    for (const p of posts) {
      expect(p.count).toBeLessThanOrEqual(BATCH_ATTEMPTS);
      expect(p.bytes).toBeLessThan(MAX_BYTES);
    }
    // The account took its 2,000; the other 1,000 are kept on the device as "account full", not sent again.
    expect((await real.get()).attempts).toHaveLength(MAX_ATTEMPTS);
    expect(b.owner.held("user_a", "full")).toHaveLength(1000);
    expect(b.local.list()).toHaveLength(3000);
    const sent = posts.length;
    await b.signIn("user_a", watched);
    expect(posts.length - sent).toBe(0);
  });

  it("a backlog that fits the account (1,500) syncs completely, in batches (F1 repro)", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    b.local.merge(Array.from({ length: 1500 }, (_, i) => record({ id: `att-c${String(i).padStart(7, "0")}`, answeredAt: new Date(Date.parse("2026-09-01T00:00:00Z") + i * 60_000).toISOString() })));
    const real = apiFor("user_a", kv);
    let posts = 0;
    await b.signIn("user_a", { ...real, post: (x) => (posts++, real.post(x)) });
    expect(posts).toBe(3);
    expect((await real.get()).attempts).toHaveLength(1500);
    expect(b.owner.pending("user_a")).toEqual([]);
  });

  it("a batch stops at BATCH_BYTES too, and always holds at least one answer", () => {
    const fat = (i: number) => ({ ...attempt({ id: `att-${String(i).padStart(8, "0")}` }), questionId: "x".repeat(10_000) }) as AccountAttempt;
    const all = Array.from({ length: 50 }, (_, i) => fat(i));
    const batch = firstBatch(all);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(all.length);
    expect(new TextEncoder().encode(JSON.stringify({ attempts: batch })).length).toBeLessThanOrEqual(BATCH_BYTES);
    expect(BATCH_BYTES).toBeLessThan(MAX_BYTES);
    expect(firstBatch([{ ...fat(0), questionId: "x".repeat(300_000) }])).toHaveLength(1);
  });

  it("Delete my data is followed by one sync, so nothing an in-flight sync merged during it lingers (F6)", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    const real = apiFor("user_a", kv);
    let calls = 0;
    const counted = { ...real, get: () => (calls++, real.get()), post: (x: Parameters<typeof real.post>[0]) => (calls++, real.post(x)) };
    const store = await b.signIn("user_a", counted);
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await store.sync();
    const before = calls;
    await store.deleteAll();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
    expect(b.local.list()).toEqual([]);
  });

  it("(1) a Delete my data on another device reaches this one through the deletion mark: its confirmed copies go at the next sync", async () => {
    const kv = memoryKV();
    const one = browser(kv);
    await one.signIn("user_a");
    one.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await vi.waitFor(async () => expect(questions((await apiFor("user_a", kv).get()).attempts)).toEqual(["demo-q1"]));
    await one.signIn("user_a");
    expect(questions(one.local.list())).toEqual(["demo-q1"]);

    // Another device deletes A's data; this device syncs again.
    await apiFor("user_a", kv).del();
    await one.signIn("user_a");
    expect(one.local.list()).toEqual([]);
  });

  it("(2) a reply whose list lacks some confirmed answers, with no deletion mark, removes nothing", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    b.answer(answer("demo-q2", "2026-10-20T16:00:00.000Z"));
    await vi.waitFor(async () => expect(questions((await apiFor("user_a", kv).get()).attempts)).toEqual(["demo-q1", "demo-q2"]));
    await b.signIn("user_a");
    expect(b.owner.owned().length).toBeGreaterThanOrEqual(2);

    // The account answers with only part of its list (and no mark): nothing leaves the device.
    const real = apiFor("user_a", kv);
    const partial = {
      ...real,
      get: async () => ({ ...(await real.get()), attempts: (await real.get()).attempts.slice(0, 1), deletedBefore: null }),
      post: async (x: Parameters<typeof real.post>[0]) => {
        const r = await real.post(x);
        return { ...r, attempts: [], deletedBefore: null };
      },
    };
    await b.signIn("user_a", partial);
    b.answer(answer("demo-q3", "2026-10-20T17:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 10));
    expect(questions(b.local.list())).toEqual(["demo-q1", "demo-q2", "demo-q3"]);
  });

  it("(3) a sync that fails, times out or gets a partial reply changes nothing on the device", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    await b.signIn("user_a");
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await vi.waitFor(async () => expect(questions((await apiFor("user_a", kv).get()).attempts)).toEqual(["demo-q1"]));
    await b.signIn("user_a");
    // q2 is answered while storage is down: it stays unsent, so every sync below is a POST (whose reply must be whole).
    kv.down = true;
    const pending = b.answer(answer("demo-q2", "2026-10-20T16:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 10));
    kv.down = false;
    const snapshot = () => ({ local: b.local.list().map((r) => r.id).sort(), owned: [...b.owner.owned()].sort(), pending: b.owner.pendingOfOthers("someone-else").sort() });
    const before = snapshot();
    const [q1] = b.local.list();

    // Each would remove q1 if it were believed (a mark after it, or an explicit older-than-delete), but each is a failure.
    const mark = "2026-10-21T00:00:00.000Z";
    const serverTime = new Date().toISOString();
    const replies: [string, () => Promise<Response>][] = [
      ["503", async () => new Response(JSON.stringify({ error: "storage-unavailable" }), { status: 503 })],
      ["timeout", async () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
      ["network", async () => Promise.reject(new TypeError("Failed to fetch"))],
      ["not json", async () => new Response("<html>", { status: 200 })],
      ["no deletedBefore", async () => new Response(JSON.stringify({ attempts: [], refused: [{ id: q1.id, reason: "older-than-delete" }], serverTime }))],
      ["no refused", async () => new Response(JSON.stringify({ attempts: [], deletedBefore: mark, serverTime }))],
      ["no attempts", async () => new Response(JSON.stringify({ refused: [], deletedBefore: mark, serverTime }))],
      ["bad attempts", async () => new Response(JSON.stringify({ attempts: [{ nope: 1 }], refused: [], deletedBefore: mark, serverTime }))],
      ["no serverTime", async () => new Response(JSON.stringify({ attempts: [], refused: [], deletedBefore: mark }))],
      ["bad mark", async () => new Response(JSON.stringify({ attempts: [], refused: [], deletedBefore: "soon", serverTime }))],
    ];
    for (const [name, reply] of replies) {
      const store = await b.signIn("user_a", accountApi((async () => reply()) as unknown as typeof fetch)).catch((e: unknown) => e);
      expect(store, name).toBeInstanceOf(Error);
      expect(snapshot(), name).toEqual(before);
    }
    expect(b.local.list().map((r) => r.id)).toContain(pending.id);
  });

  it("a future-dated answer (this device's clock runs ahead) is sent once, then held until the server's time reaches it", async () => {
    let t = Date.parse("2026-10-24T22:00:00Z");
    const kv = memoryKV(() => t);
    const b = browser(kv);
    const posts: string[][] = [];
    const real = apiFor("user_a", kv, () => t);
    const watched = { ...real, post: (x: Parameters<typeof real.post>[0]) => (posts.push(x.map((a) => a.id)), real.post(x)) };
    await b.signIn("user_a", watched);
    const ahead = b.answer(answer("demo-q1", "2026-10-24T22:10:00.000Z"));
    await vi.waitFor(() => expect(posts.flat()).toContain(ahead.id));

    // More answers and retries while the server's time is still far behind it: not sent again.
    const sent = posts.length;
    for (let i = 0; i < 3; i++) {
      b.answer(answer("demo-q2", `2026-10-24T22:0${i}:30.000Z`));
      await vi.waitFor(() => expect(posts.length).toBeGreaterThan(sent + i));
    }
    expect(posts.slice(sent).flat()).not.toContain(ahead.id);

    // The server's time reaches it (within the 5 minutes' slack): the next syncs send it, and it goes in.
    t = Date.parse("2026-10-24T22:06:00Z");
    const store = await b.signIn("user_a", watched);
    await store.sync();
    await vi.waitFor(async () => expect((await real.get()).attempts.map((a) => a.id)).toContain(ahead.id));
  });

  it("Delete my data waiting on a running sync keeps answers given meanwhile, and sends them after", async () => {
    const kv = memoryKV();
    const b = browser(kv);
    const real = apiFor("user_a", kv);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let hold = false;
    const slow = {
      ...real,
      post: async (x: Parameters<typeof real.post>[0]) => {
        const r = await real.post(x);
        if (hold) await gate;
        return r;
      },
    };
    const store = await b.signIn("user_a", slow);
    b.answer(answer("demo-q1", "2026-10-20T15:00:00.000Z"));
    await vi.waitFor(async () => expect(questions((await real.get()).attempts)).toEqual(["demo-q1"]));
    // A sync is running (held); the student deletes, then answers while the delete waits on that sync.
    hold = true;
    b.answer(answer("demo-q2", "2026-10-20T16:00:00.000Z"));
    await new Promise((r) => setTimeout(r, 0));
    const deleting = store.deleteAll();
    const during = b.answer(answer("demo-q3", new Date(Date.now() + 1000).toISOString()));
    hold = false;
    release();
    await deleting;
    // q1 and q2 were on the device when the delete was asked: gone. q3 came after: kept, and sent.
    expect(questions(b.local.list())).toEqual(["demo-q3"]);
    await vi.waitFor(async () => expect((await real.get()).attempts.map((a) => a.id)).toEqual([during.id]));
  });
});
