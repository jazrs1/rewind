// Fakes for the Quick build tests: synthetic course text (never a real export), a counting model, a recording store.

import { memoryStore, type CounterStore } from "../demo/tutor-store.ts";
import { fakeQuickModel } from "./fake.ts";
import { handleQuickGenerate, type QuickDeps } from "./route.ts";
import type { QuickModel } from "./service.ts";
import type { QuickChunk, QuickRequest } from "./types.ts";

export const ZOOM = "https://example.zoom.us/rec/play/FAKE-TOKEN";

const SENTENCES = [
  "A hash table maps keys to buckets and finds a key in constant time on average.",
  "With linear probing, a collision moves the key to the next free slot in the table.",
  "A graph is connected if there is a path between every pair of vertices in it.",
  "A binary search tree keeps smaller keys on the left and larger keys on the right.",
  "Merge sort splits the array in half, sorts each half, and then merges the two halves.",
  "A stack removes the item that was added last, and a queue removes the item added first.",
];

/** A page chunk of about 200 characters. */
export function pageChunk(i: number, extra = ""): QuickChunk {
  const text = `${SENTENCES[i % SENTENCES.length]} ${SENTENCES[(i + 1) % SENTENCES.length]}${extra ? ` ${extra}` : ""} Module ${i}.`;
  return { id: `pg${i}`, kind: "page", title: `Module ${i}: topic`, text };
}

/** A lecture chunk: lines at 3463 s onward, 7 s apart, so the first line is 57:43. */
export function lectureChunk(i: number, lines: string[] = [SENTENCES[0], SENTENCES[1], SENTENCES[2]]): QuickChunk {
  const segments = lines.map((text, k) => ({ start: 3463 + i * 100 + k * 7, end: 3470 + i * 100 + k * 7, text }));
  return {
    id: `lec${i}`,
    kind: "lecture",
    title: "Lecture, Oct 22",
    text: lines.join(" "),
    lecture: { recordingUrl: ZOOM, recordedAt: "2026-10-22T17:48:09Z", segments },
  };
}

export const course = { code: "FAKE1001", name: "Data Structures (Demo)" };

export function request(chunks: QuickChunk[]): QuickRequest {
  return { course, chunks };
}

/** Five page chunks: one batch's worth of questions. */
export const fiveChunks = () => [0, 1, 2, 3, 4].map((i) => pageChunk(i));

export interface Calls {
  model: number;
  prompts: string[];
}

export function countingModel(inner: QuickModel = fakeQuickModel({ delayMs: 0 })): { model: QuickModel; calls: Calls } {
  const calls: Calls = { model: 0, prompts: [] };
  return {
    calls,
    model: async (prompt, schema, opts) => {
      calls.model++;
      calls.prompts.push(prompt);
      return inner(prompt, schema, opts);
    },
  };
}

/** A store that records what is written to it. */
export function recordingStore(inner: CounterStore = memoryStore()): { store: CounterStore; writes: { key: string; n: number }[] } {
  const writes: { key: string; n: number }[] = [];
  return {
    writes,
    store: {
      kind: inner.kind,
      incrBy: (key, n, ttl) => (writes.push({ key, n }), inner.incrBy(key, n, ttl)),
      incrMany: (ops) => (ops.forEach((o) => writes.push({ key: o.key, n: o.n })), inner.incrMany(ops)),
      get: (k) => inner.get(k),
      getMany: (ks) => inner.getMany(ks),
    },
  };
}

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://rewindit.org/api/quick/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function deps(over: Partial<QuickDeps> = {}): QuickDeps & { calls: Calls } {
  const m = countingModel();
  return { enabled: true, key: "fake-key-for-tests", model: () => m.model, store: memoryStore(), now: () => Date.parse("2026-10-24T21:00:00Z"), calls: m.calls, ...over };
}

/** Sends a request and returns the JSON, the status and the cookie to send next time. */
export async function send(body: unknown, d: QuickDeps, headers: Record<string, string> = {}) {
  const res = await handleQuickGenerate(post(body, headers), d);
  const set = res.headers.get("set-cookie");
  return { status: res.status, json: (await res.json()) as { questions?: { id: string; source: { sec?: number }; quote: string }[]; refused?: { reason: string }[]; error?: string }, cookie: set ? set.split(";")[0] : null };
}
