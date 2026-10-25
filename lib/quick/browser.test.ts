import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { toAccountAttempt } from "../accounts/schema.ts";
import { recordAttempt } from "../attempts/client.ts";
import { browserAttemptStore, courseKey, type StorageLike } from "../attempts/store.ts";
import { memoryStore } from "../demo/tutor-store.ts";
import { buildPractice } from "./client.ts";
import { batchesOf, chunksOf, htmlToText, lectureChunks, lecturerOf, pageChunks, pickChunks, readFile, type ExportFiles } from "./export.ts";
import { fakeQuickModel } from "./fake.ts";
import { parseRequest } from "./schema.ts";
import { quickLLM, writeQuestions } from "./service.ts";
import { bankToSeed, clipOf, questionToSeed, sourceLine } from "./seed.ts";
import { createBankStore, parseBank, quickKey } from "./store.ts";
import { countingModel, course, lectureChunk, pageChunk, request } from "./test-helpers.ts";
import type { QuickQuestion, QuickResponse } from "./types.ts";

afterEach(() => vi.unstubAllGlobals());

const S = (s: string, o: Record<string, unknown> = {}) => ({ start: 0, end: 5, speaker: "Lecturer", text: s, ...o });
const transcript = (segments: ReturnType<typeof S>[]) => ({
  title: "Lecture, Oct 22",
  recordedAt: "2026-10-22T17:48:09Z",
  recordingUrl: "https://example.zoom.us/rec/play/FAKE-TOKEN",
  segments,
});

/** A minimal stand-in for DOMParser's document: nodes with a tag, text or children. */
type N = { nodeType: 1 | 3; tagName?: string; nodeValue?: string; childNodes: N[] & { forEach: (fn: (n: N) => void) => void } };
const el = (tagName: string, ...kids: N[]): N => ({ nodeType: 1, tagName, childNodes: kids as N["childNodes"] });
const tx = (nodeValue: string): N => ({ nodeType: 3, nodeValue, childNodes: [] as unknown as N["childNodes"] });
const doc = (...kids: N[]) => ({ body: el("BODY", ...kids) }) as unknown as Document;

describe("export files to chunks", () => {
  it("turns page HTML into lines of text, dropping scripts and keeping breaks", () => {
    const d = doc(el("P", tx("A hash table maps   keys.")), el("SCRIPT", tx("alert(1)")), el("DIV", tx("Next"), el("BR"), tx("line")));
    expect(htmlToText("ignored", () => d)).toBe("A hash table maps keys.\nNext\nline");
  });

  it("reads only titles and bodies from a course export, never grades or submissions", () => {
    const parse = () => doc(el("P", tx("Collisions move to the next slot.")));
    const got = readFile(
      {
        exportedAt: "x",
        course: { id: 1, name: "Data Structures (Demo)", course_code: "FAKE1001" },
        pages: [{ page_id: 1, title: "Module 3", url: "m3", body: "<p>x</p>" }, { title: "Empty", body: "  " }],
        files: [{ id: 9, display_name: "slides.pdf" }],
        submissions: [{ grade: "98", user: { name: "Real Student" } }],
        assignments: [{ name: "HW", points_possible: 10 }],
      },
      parse,
    );
    expect(got).toEqual({ kind: "course", course: { code: "FAKE1001", name: "Data Structures (Demo)" }, pages: [{ title: "Module 3", text: "Collisions move to the next slot." }] });
    expect(JSON.stringify(got)).not.toMatch(/Real Student|98|slides\.pdf|HW/);
  });

  it("recognises a transcript, and nothing else", () => {
    expect(readFile(transcript([S("Hello there everyone.")]))).toMatchObject({ kind: "transcript" });
    expect(readFile({ hello: 1 })).toBeNull();
    expect(readFile([1, 2])).toBeNull();
  });

  it("keeps only the lecturer's lines: the most words; others and unlabelled lines are dropped", () => {
    const t = readFile(
      transcript([
        S("A graph is connected if there is a path between every pair of vertices.", { start: 3463, end: 3470 }),
        S("Can you repeat that please?", { speaker: "Student A", start: 3471, end: 3473 }),
        S("Unlabelled voice saying something.", { speaker: null, start: 3474, end: 3476 }),
        S("Sure. A tree is a connected graph without cycles in it.", { start: 3477, end: 3482 }),
      ]),
    );
    if (t?.kind !== "transcript") throw new Error("no transcript");
    expect(lecturerOf(t.transcript)).toBe("Lecturer");
    const chunks = lectureChunks(t.transcript, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("A graph is connected if there is a path between every pair of vertices. Sure. A tree is a connected graph without cycles in it.");
    expect(chunks[0].lecture!.segments.map((s) => s.start)).toEqual([3463, 3477]);
    expect(chunks[0].text).not.toMatch(/repeat|Unlabelled/);
    expect(parseRequest(JSON.stringify(request(chunks))).ok).toBe(true);
  });

  it("makes no lecture chunks without a lecturer, a recording or a date", () => {
    expect(lectureChunks({ source: "zoom", recordingUrl: "https://a.zoom.us/x", title: "t", recordedAt: null, durationSec: 0, segments: [{ start: 0, end: 1, speaker: "A", text: "hello" }] }, 0)).toEqual([]);
    expect(lectureChunks({ source: "zoom", recordingUrl: "https://a.zoom.us/x", title: "t", recordedAt: "2026-10-22T17:48:09Z", durationSec: 0, segments: [{ start: 0, end: 1, speaker: null, text: "hello" }] }, 0)).toEqual([]);
  });

  it("chunks long lectures at 800 characters, 40 lines, in order", () => {
    const lines = Array.from({ length: 60 }, (_, i) => S(`Line number ${i} says that a queue removes the item that was added first.`, { start: i * 10, end: i * 10 + 9 }));
    const t = readFile(transcript(lines));
    if (t?.kind !== "transcript") throw new Error();
    const chunks = lectureChunks(t.transcript, 2);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(800);
      expect(c.lecture!.segments.length).toBeLessThanOrEqual(40);
      expect(parseRequest(JSON.stringify(request([c]))).ok).toBe(true);
    }
    const starts = chunks.flatMap((c) => c.lecture!.segments.map((s) => s.start));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it("splits long pages at about 800 characters and drops chunks the server would refuse", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} explains hashing and probing in detail.`).join(" ");
    const pages = pageChunks([{ title: "Hash tables", text: long }]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => p.text.length <= 800)).toBe(true);
    const files: ExportFiles = { course, pages: [{ title: "Bad", text: "<script>x()</script> and some more words here" }, { title: "Good", text: long }], transcripts: [] };
    const { chunks, dropped } = chunksOf(files);
    expect(dropped).toBe(1);
    expect(chunks.every((c) => c.title === "Good")).toBe(true);
  });

  it("picks at most 36 long chunks, lectures and pages both, in order, in batches of 12", () => {
    const many = [...Array.from({ length: 80 }, (_, i) => pageChunk(i)), ...Array.from({ length: 80 }, (_, i) => lectureChunk(i))];
    const picked = pickChunks(many);
    expect(picked).toHaveLength(36);
    expect(picked.filter((c) => c.kind === "lecture")).toHaveLength(18);
    expect(picked.map((c) => many.indexOf(c))).toEqual(picked.map((c) => many.indexOf(c)).sort((a, b) => a - b));
    const batches = batchesOf(picked, course);
    expect(batches.map((b) => b.chunks.length)).toEqual([12, 12, 12]);
    expect(pickChunks([pageChunk(0), { ...pageChunk(1), text: "short" }])).toHaveLength(1);
  });
});

describe("Build my practice (the browser's runner)", () => {
  const files: ExportFiles = { course, pages: Array.from({ length: 30 }, (_, i) => ({ title: `Module ${i}`, text: pageChunk(i).text })), transcripts: [] };
  const q = (i: number): QuickQuestion => ({
    id: `qb-${i}`,
    stem: `Question ${i}?`,
    code: null,
    choices: ["A", "B", "C", "D"].map((l) => ({ label: l as "A", text: `Choice ${l}` })),
    answer: "B",
    explanation: "Because.",
    quote: "A hash table maps keys",
    source: { kind: "page", title: "Module" },
  });
  const reply = (qs: QuickQuestion[], status = 200, error?: string) => new Response(JSON.stringify(error ? { error, questions: [], refused: [] } : ({ questions: qs, refused: [] } satisfies QuickResponse)), { status });

  it("sends the batches one at a time, reports progress, and stops at 15", async () => {
    let n = 0;
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return reply(Array.from({ length: 5 }, () => q(n++)));
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    const r = await buildPractice({ files, fetchFn, onProgress: (p) => seen.push(p.questions) });
    expect(r.questions).toHaveLength(15);
    expect(r.stopped).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([0, 5, 10, 15]);
    // Every body passes the server's schema and carries nothing but the course name/code and chunks.
    for (const b of bodies) {
      expect(parseRequest(b).ok).toBe(true);
      expect(Object.keys(JSON.parse(b)).sort()).toEqual(["chunks", "course"]);
    }
  });

  it("does not send a fourth batch once it has 15", async () => {
    const fetchFn = vi.fn(async () => reply(Array.from({ length: 15 }, (_, i) => q(i)))) as unknown as typeof fetch;
    const r = await buildPractice({ files, fetchFn });
    expect(r.questions).toHaveLength(15);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps what it has and says why when a limit or an outage stops it", async () => {
    let call = 0;
    const fetchFn = (async () => (call++ === 0 ? reply([q(1), q(2)]) : reply([], 429, "visitor"))) as unknown as typeof fetch;
    const r = await buildPractice({ files, fetchFn });
    expect(r.questions).toHaveLength(2);
    expect(r.stopped).toBe("limit");
    expect((await buildPractice({ files, fetchFn: (async () => reply([], 429, "rate")) as unknown as typeof fetch })).stopped).toBe("rate");
    expect((await buildPractice({ files, fetchFn: (async () => reply([], 503, "unavailable")) as unknown as typeof fetch })).stopped).toBe("unavailable");
    expect((await buildPractice({ files, fetchFn: (async () => { throw new Error("offline"); }) as unknown as typeof fetch })).stopped).toBe("error");
    expect((await buildPractice({ files: { course, pages: [], transcripts: [] } })).stopped).toBe("nothing");
  });
});

describe("the bank on this device", () => {
  const bank = { course, builtAt: "2026-10-24T21:00:00Z", questions: [{ id: "qb-1", stem: "Which?", code: null, choices: ["A", "B", "C", "D"].map((l) => ({ label: l as "A", text: l })), answer: "A" as const, explanation: "x", quote: "A hash table maps keys", source: { kind: "lecture" as const, title: "Lecture, Oct 22", sec: 2290, recordingUrl: "https://a.zoom.us/x" } }] };
  const fake = () => {
    const m = new Map<string, string>();
    return { m, s: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } } };
  };

  it("writes under rewind.quick.v1.<course>, reads it back, lists it and clears it", () => {
    const { m, s } = fake();
    const store = createBankStore(() => s);
    const seen = vi.fn();
    store.subscribe(seen);
    store.write(bank);
    // courseKey() reads the first three letters then four digits, as the attempts store does ("FAKE1001" is "AKE1001").
    expect([...m.keys()]).toEqual(["rewind.quick.v1.AKE1001"]);
    expect(quickKey("fake1001")).toBe(quickKey("FAKE1001"));
    expect(store.read("FAKE1001")?.questions).toHaveLength(1);
    expect(store.read("FAKE1001")).toBe(store.read("FAKE1001"));
    expect(store.list()).toHaveLength(1);
    store.clear("FAKE1001");
    expect(m.size).toBe(0);
    expect(store.read("FAKE1001")).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("treats a damaged or other-version value as no bank", () => {
    expect(parseBank("{nope")).toBeNull();
    expect(parseBank(JSON.stringify({ v: 2, course, questions: [] }))).toBeNull();
    expect(parseBank(JSON.stringify({ v: 1, course, questions: [{ id: 1 }] }))).toBeNull();
    expect(parseBank(null)).toBeNull();
  });

  it("falls back to memory when storage throws", () => {
    const boom = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } } satisfies StorageLike;
    const store = createBankStore(() => boom);
    store.write(bank);
    expect(store.read("FAKE1001")?.questions).toHaveLength(1);
    store.clear("FAKE1001");
    expect(store.read("FAKE1001")).toBeNull();
    expect(createBankStore(() => null).list()).toEqual([]);
  });

  it("shows a lecture question as 'Lecture, Oct 22 · 38:10' and a page as 'Page: <title>'", () => {
    expect(sourceLine({ kind: "lecture", title: "Lecture, Oct 22", sec: 2290 })).toBe("Lecture, Oct 22 · 38:10");
    expect(sourceLine({ kind: "page", title: "Module 3: Hash tables" })).toBe("Page: Module 3: Hash tables");
    const seed = bankToSeed({ v: 1, ...bank });
    expect(seed.questions[0].quick).toEqual({ label: "Lecture, Oct 22 · 38:10", where: "Lecture, Oct 22 at 38:10", quote: "A hash table maps keys" });
    expect(seed.questions[0].match.slide.excerpt).toBe("A hash table maps keys");
    expect(seed.questions[0].n).toBe(1);
  });
});

describe("a lecture question's clip on the student's own recording (Phase 2)", () => {
  const lines = [
    { start: 2280, text: "First we define a graph." },
    { start: 2290, text: "A graph is connected if there is a path" },
    { start: 2300, text: "between every pair of vertices." },
  ];
  const lecture = { kind: "lecture" as const, title: "Lecture, Oct 22", sec: 2290, recordingUrl: "https://example.zoom.us/rec/play/FAKE-TOKEN", lines };

  it("seeks to the quote's second, runs up to 45 s but not past the stored lines", () => {
    expect(clipOf(lecture)).toEqual({ start: 2290, end: 2307 });
    expect(clipOf({ ...lecture, lines: undefined })).toEqual({ start: 2290, end: 2297 });
    expect(clipOf({ ...lecture, lines: [...lines, { start: 2400, text: "much later" }] })).toEqual({ start: 2290, end: 2335 });
  });

  it("has no clip for a page, or a lecture without its recording or second", () => {
    expect(clipOf({ kind: "page", title: "Module 3" })).toBeNull();
    expect(clipOf({ ...lecture, recordingUrl: undefined })).toBeNull();
    expect(clipOf({ ...lecture, sec: undefined })).toBeNull();
  });

  it("puts the clip, the recording and the stored lines in the practice seed", () => {
    const q = questionToSeed({ id: "qb-1", stem: "s", code: null, choices: ["A", "B", "C", "D"].map((l) => ({ label: l as "A", text: l })), answer: "A", explanation: "x", quote: "A graph is connected", source: lecture }, 1);
    expect(q.match).toMatchObject({ start: 2290, end: 2307, recordingUrl: lecture.recordingUrl });
    expect(q.segments.map((s) => [s.start, s.end, s.speaker])).toEqual([[2280, 2290, null], [2290, 2300, null], [2300, 2307, null]]);
    const page = questionToSeed({ id: "qb-2", stem: "s", code: null, choices: q.choices, answer: "A", explanation: "x", quote: "q", source: { kind: "page", title: "Module 3" } }, 2);
    expect(page.match.start).toBeNull();
    expect(page.segments).toEqual([]);
  });

  it("the service sends back the chunk's lines with a lecture question", async () => {
    const { model } = countingModel();
    const out = await writeQuestions(request([lectureChunk(0)]), { llm: quickLLM({ model, store: memoryStore(), now: () => 0 }), count: 1 });
    expect(out.questions[0].source.lines?.map((l) => l.start)).toEqual([3463, 3470, 3477]);
  });
});

describe("practice answers leave the device without the bank", () => {
  it("records a Quick build answer with no stem or title, and the account payload has no bank text", () => {
    const m = new Map<string, string>();
    const local = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    vi.stubGlobal("window", { localStorage: local, addEventListener() {}, removeEventListener() {} });
    const bank = { v: 1, course, builtAt: "x", questions: [{ id: "qb-abc123", stem: "Which words begin the SECRET-STEM text?", code: null, choices: ["A", "B", "C", "D"].map((l) => ({ label: l as "A", text: `SECRET-CHOICE ${l}` })), answer: "B" as const, explanation: "SECRET-WHY", quote: "SECRET-QUOTE from the lecture", source: { kind: "lecture" as const, title: "SECRET-TITLE", sec: 12 } }] };
    const seed = bankToSeed(bank);
    recordAttempt(seed, seed.questions[0], "A", "guessing");
    const [rec] = browserAttemptStore(course.code).list();
    expect(rec.stem).toBeNull();
    expect(rec.topic).toBe("Quick build");
    expect(rec.correct).toBe(false);
    // What Accounts Lite sends (the existing mapping), and what is stored locally under the attempts key.
    const sent = JSON.stringify(toAccountAttempt(rec, courseKey(course.code)));
    expect(sent).toContain("qb-abc123");
    expect(sent).not.toMatch(/SECRET/);
    expect([...m.values()].join("")).not.toMatch(/SECRET/);
  });
});

describe("the answer check", () => {
  it("drops a question whose blind answer disagrees with the key (and asks the check exactly once per attempt)", async () => {
    const inner = fakeQuickModel({ delayMs: 0 });
    const disagree = countingModel(async (prompt, schema, opts) => {
      const r = await inner(prompt, schema, opts);
      // The blind checker answers C where the key says B.
      return /^You check practice questions/.test(prompt) ? { ...r, reply: { ...(r.reply as object), answer: "C" } } : r;
    });
    const out = await writeQuestions(request([pageChunk(0)]), { llm: quickLLM({ model: disagree.model, store: memoryStore(), now: () => 0 }), count: 1 });
    expect(out.questions).toEqual([]);
    expect(out.refused).toEqual([{ reason: "checks" }]);
    // 3 attempts, each: one question call and one check call.
    expect(disagree.calls.prompts.filter((p) => p.startsWith("You check practice questions"))).toHaveLength(3);
    // The check never sees the key.
    const check = disagree.calls.prompts.find((p) => p.startsWith("You check practice questions"))!;
    expect(check).not.toMatch(/Correct answer|The text begins with them/);
  });
});

describe("what the browser bundles", () => {
  // components/quick/* run in the browser: a server module anywhere in their imports breaks /extension's build
  // (Turbopack: "does not support external modules (request: node:fs/promises)"), as generate.ts once did.
  const SERVER = /^node:|^(fs|path|crypto|child_process|os)$|\/(llm|gemini)\.ts$|\/pipeline\/generate\.ts$/;
  const importsOf = (file: string): string[] =>
    [...readFileSync(file, "utf8").matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm)].map((m) => m[1]);
  const resolve = (from: string, spec: string) =>
    spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? posix.join(posix.dirname(from), spec) : spec;

  it("never reaches a Node built-in or a server module from components/quick", () => {
    const seen = new Set<string>();
    const bad: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        const to = resolve(file, spec);
        if (SERVER.test(to)) bad.push(`${file} -> ${spec}`);
        else if (to.startsWith("lib/") || to.startsWith("components/")) {
          const path = [to, `${to}.ts`, `${to}.tsx`].find((p) => existsSync(p) && /\.tsx?$/.test(p));
          if (path) walk(path);
        }
      }
    };
    walk("components/quick/BuildPractice.tsx");
    walk("components/quick/QuickPractice.tsx");
    expect(bad).toEqual([]);
    expect(seen.has("lib/quick/export.ts")).toBe(true);
  });
});
