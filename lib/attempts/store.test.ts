// Attempt store on an in-memory storage fake (no DOM), plus the demo example history.
import { describe, expect, it, vi } from "vitest";
import { exampleHistory, exampleSeedOf, isDemoSeed, type ExampleSeed } from "./examples.ts";
import { compactAttemptId, courseKey, createAttemptStore, storageKey, type NewAttempt, type StorageLike } from "./store.ts";

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

/** Storage that throws on every call, like Safari private mode or blocked site data. */
const throwing: StorageLike = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

const answer = (over: Partial<NewAttempt> = {}): NewAttempt => ({
  questionId: "q1",
  topic: "3 - Widgets",
  stem: "Which widget turns first?",
  choice: "B",
  correct: false,
  confidence: "guessing",
  answeredAt: "2026-09-10T15:00:00Z",
  ...over,
});

const seed: ExampleSeed = {
  course: { code: "COP3530" },
  questions: ["q1", "q2", "q3", "q4", "q5"].map((id, i) => ({
    id,
    stem: `Invented question ${i + 1}?`,
    answer: "C" as const,
    choices: (["A", "B", "C", "D"] as const).map((label) => ({ label, text: `choice ${label}` })),
    topic: i < 2 ? "3 - Widgets" : "4 - Gizmos",
  })),
};

function setup(storage: StorageLike | null = new MemoryStorage()) {
  return { storage, store: createAttemptStore({ course: "XYZ1000", storage: () => storage }) };
}

describe("attempt store", () => {
  it("adds, lists and persists attempts under a versioned per-course key", () => {
    const { storage, store } = setup();
    expect(store.list()).toEqual([]);
    const a = store.add(answer());
    expect(a.example).toBe(false);
    expect(a.id).toMatch(/^att-/);
    expect(store.list()).toEqual([a]);
    expect(storageKey("XYZ1000")).toBe("rewind.attempts.v1.XYZ1000");
    expect(JSON.parse((storage as MemoryStorage).getItem("rewind.attempts.v1.XYZ1000")!)).toEqual({ v: 1, attempts: [a] });
    // A second store on the same storage (another page) sees it.
    expect(createAttemptStore({ course: "XYZ1000", storage: () => storage }).list()).toEqual([a]);
    // Another course doesn't.
    expect(createAttemptStore({ course: "ABC2000", storage: () => storage }).list()).toEqual([]);
  });

  it("returns the same array until something changes (for useSyncExternalStore)", () => {
    const { store } = setup();
    store.add(answer());
    const first = store.list();
    expect(store.list()).toBe(first);
    store.add(answer({ questionId: "q2" }));
    expect(store.list()).not.toBe(first);
    expect(store.list()).toHaveLength(2);
  });

  it("clear really clears: no attempt data is left in storage", () => {
    const { storage, store } = setup();
    store.add(answer());
    store.add(answer({ correct: true, choice: "C" }));
    store.clear();
    expect(store.list()).toEqual([]);
    const left = [...(storage as MemoryStorage).data.entries()];
    expect(left.some(([, v]) => v.includes("q1") || v.includes("widget"))).toBe(false);
    expect((storage as MemoryStorage).getItem(storageKey("XYZ1000"))).toBeNull();
  });

  it("notifies subscribers on add, clear and seeding, and stops after unsubscribe", () => {
    const { store } = setup();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.add(answer());
    store.clear();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    store.add(answer());
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("ignores corrupt, foreign-version and malformed data", () => {
    const storage = new MemoryStorage();
    const { store } = setup(storage);
    storage.setItem(storageKey("XYZ1000"), "{not json");
    expect(store.list()).toEqual([]);
    storage.setItem(storageKey("XYZ1000"), JSON.stringify({ v: 99, attempts: [{ id: "x" }] }));
    expect(store.list()).toEqual([]);
    storage.setItem(storageKey("XYZ1000"), JSON.stringify({ v: 1, attempts: [{ id: "x" }, null] }));
    expect(store.list()).toEqual([]);
  });

  it("works in memory when storage throws (private mode) or is missing (server)", () => {
    for (const storage of [throwing, null]) {
      const { store } = setup(storage);
      expect(store.list()).toEqual([]);
      const a = store.add(answer());
      expect(store.list()).toEqual([a]);
      store.clear();
      expect(store.list()).toEqual([]);
    }
  });

  it("keeps working in memory when a write fails part way (quota)", () => {
    const storage = new MemoryStorage();
    const { store } = setup(storage);
    store.add(answer());
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    store.add(answer({ questionId: "q2" }));
    expect(store.list().map((a) => a.questionId)).toEqual(["q1", "q2"]);
  });
});

describe("example history", () => {
  const now = "2026-10-23T20:00:00Z";

  it("is only for the demo seed", () => {
    expect(isDemoSeed({ course: { code: "COP3530" } })).toBe(true);
    expect(isDemoSeed({ course: { code: "MAS3114" } })).toBe(false);
    expect(exampleHistory({ ...seed, course: { code: "MAS3114" } }, now)).toEqual([]);
    expect(exampleHistory(null, now)).toEqual([]);
  });

  it("a handful of plausible attempts across the seed's topics, some wrong, all in the past", () => {
    const ex = exampleHistory(seed, now);
    expect(ex.length).toBeGreaterThanOrEqual(3);
    expect(ex.length).toBeLessThanOrEqual(6);
    expect(new Set(ex.map((a) => a.topic))).toEqual(new Set(["3 - Widgets", "4 - Gizmos"]));
    expect(ex.some((a) => !a.correct)).toBe(true);
    expect(ex.some((a) => a.correct)).toBe(true);
    for (const a of ex) {
      expect(a.correct).toBe(a.choice === "C");
      expect(a.answeredAt < now).toBe(true);
    }
    expect(ex.map((a) => a.answeredAt)).toEqual([...ex.map((a) => a.answeredAt)].sort());
  });

  it("exampleSeedOf keeps only what the examples need, and only for the demo course", () => {
    const full = {
      course: { code: "COP3530", name: "Invented" },
      questions: [
        {
          id: "q1",
          n: 1,
          stem: "S?",
          answer: "A" as const,
          choices: [{ label: "A" as const, text: "a" }],
          match: { start: 1, end: 2, exampleStart: null, setup: null, sourceLines: [], slide: { deck: "7 - Deck", page: 3, image: "x.png" } },
          segments: [{ start: 0, end: 1, speaker: "P", text: "lecture line" }],
        },
      ],
    };
    expect(exampleSeedOf(full)).toEqual({ course: { code: "COP3530" }, questions: [{ id: "q1", stem: "S?", answer: "A", choices: [{ label: "A", text: "a" }], topic: "7 - Deck" }] });
    expect(exampleSeedOf({ ...full, course: { code: "MAS3114", name: "x" } })).toBeNull();
  });

  it("seeds only an empty store, all marked example", () => {
    const { store } = setup();
    expect(store.seedExamples(exampleHistory(seed, now))).toBe(true);
    expect(store.list().length).toBeGreaterThan(0);
    expect(store.list().every((a) => a.example)).toBe(true);
    // Already seeded: no second copy.
    expect(store.seedExamples(exampleHistory(seed, now))).toBe(false);
    expect(store.list()).toHaveLength(exampleHistory(seed, now).length);
  });

  it("never seeds over real attempts", () => {
    const { store } = setup();
    store.add(answer());
    expect(store.seedExamples(exampleHistory(seed, now))).toBe(false);
    expect(store.list().every((a) => !a.example)).toBe(true);
  });

  it("a real answer clears every example first", () => {
    const { store } = setup();
    store.seedExamples(exampleHistory(seed, now));
    const real = store.add(answer());
    expect(store.list()).toEqual([real]);
  });

  it("examples don't come back after a clear or after real answers were cleared", () => {
    const storage = new MemoryStorage();
    const { store } = setup(storage);
    store.seedExamples(exampleHistory(seed, now));
    store.clear();
    expect(store.list()).toEqual([]);
    // A fresh page load on the same device.
    const again = createAttemptStore({ course: "XYZ1000", storage: () => storage });
    expect(again.seedExamples(exampleHistory(seed, now))).toBe(false);
    expect(again.list()).toEqual([]);
  });
});

describe("courseKey", () => {
  it("normalizes course codes", () => {
    expect(courseKey("COP3530 - Fa26")).toBe("COP3530");
    expect(courseKey("cop 3530")).toBe("COP3530");
    expect(courseKey("Intro Course")).toBe("intro-course");
  });
});

describe("attempt ids", () => {
  it("are at most 40 characters, and older long ids read back in the same short form every time", () => {
    const storage = new MemoryStorage();
    const store = createAttemptStore({ course: "COP3530", storage: () => storage });
    expect(store.add(answer()).id).toMatch(/^att-[a-z0-9]{32}$/);
    const old = "att-1b4e28ba-2fa1-41d2-883f-0e9d2a3c5b71-3";
    expect(compactAttemptId(old)).toBe("att-1b4e28ba2fa141d2883f0e9d2a3c5b71");
    expect(compactAttemptId(compactAttemptId(old))).toBe(compactAttemptId(old));
    storage.setItem(storageKey("COP3530"), JSON.stringify({ v: 1, attempts: [{ ...answer(), id: old, example: false }] }));
    const reread = createAttemptStore({ course: "COP3530", storage: () => storage });
    expect(reread.list()[0].id).toBe("att-1b4e28ba2fa141d2883f0e9d2a3c5b71");
  });

  it("remove deletes only those ids", () => {
    const storage = new MemoryStorage();
    const store = createAttemptStore({ course: "COP3530", storage: () => storage });
    const a = store.add(answer());
    const b = store.add(answer({ questionId: "q2" }));
    store.remove([a.id]);
    expect(store.list().map((r) => r.id)).toEqual([b.id]);
  });
});
