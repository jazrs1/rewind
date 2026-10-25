import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundExam } from "./exams";
import { fixtureOutput, fixtureTranscripts } from "./fixtures/practice-real";
import { examsForPractice, formatPlan, legacySlideName, MANIFEST_FILE, pageKindOfPng, parseRenderedManifest, planRun, readManifest, runPipeline, slideImageName, slideNeedsRender, STAGE_FILES, toPracticeSeed, type RunDeps, type RunExport } from "./run";
import type { PipelineOutput, PipelineTranscript, PracticeQuestion } from "./types";

// Invented course data only.
const sourced = <T>(value: T | null, itemId: string | null = value === null ? null : "syllabus:7") => ({ value, quote: value === null ? null : String(value), itemId });
const exam = (id: string, name: string, date: string | null, topics: string[] | null = null): FoundExam => ({
  id, courseId: "7", name: sourced(name), date: sourced(date), location: sourced<string>(null), format: sourced<string>(null),
  notesRule: sourced<"printed" | "handwritten" | "none">(null), topics: sourced(topics), searched: [], conflicts: [], windowCloses: null,
});

const exp: RunExport = {
  course: { id: 7, name: "Fake DS", course_code: "FAKE7" },
  files: [{ id: 1, display_name: "Heaps.pdf", "content-type": "application/pdf", url: "https://files.example/1?t=1" }],
  syllabus_body: "<p>Exam 2 covers heaps.</p>",
};
const items = [{ fileId: 1, name: "Heaps.pdf", role: "lecture" }];

const question = (id: string, clip: { recordingUrl: string; start: number } | null, slide = true): PracticeQuestion => ({
  id, examId: "exam:exam-2", topic: "heaps", stem: `Stem ${id}?`, code: null,
  choices: [{ label: "A", text: "a" }, { label: "B", text: "b" }, { label: "C", text: "c" }, { label: "D", text: "d" }],
  answer: "B", explanation: "Because.", quote: "Insert sifts up",
  quoteSource: { kind: "slide", itemId: "file:1", fileId: 1, page: 2, deck: "Heaps", href: "https://ufl.instructure.com/courses/7/files/1#page=2" },
  styleItemId: null, check: { agreed: true, attempts: 1, reason: null },
  retrieval: {
    clip: clip ? { recordingUrl: clip.recordingUrl, start: clip.start, end: clip.start + 40, exampleStart: clip.start - 30, setup: "He is at the board.", sourceLines: [3], transcriptId: "t1" } : null,
    slide: slide ? { kind: "slide", itemId: "file:1", fileId: 1, page: 2, deck: "Heaps", href: "https://ufl.instructure.com/courses/7/files/1#page=2" } : null,
    fallback: clip ? null : slide ? "slide" : "none",
  },
  prompts: {},
});

function fakeDeps(files: Map<string, string> = new Map()) {
  const calls: string[] = [];
  const deps: RunDeps = {
    read: async (f) => files.get(f) ?? null,
    write: async (f, t) => {
      files.set(f, t);
    },
    download: async (targets) => {
      calls.push("download");
      return targets.map((t) => ({ fileId: t.fileId, itemId: t.itemId, name: t.name, role: t.role, ext: t.ext, file: `${t.fileId}.pdf`, status: "present" as const }));
    },
    extract: async () => {
      calls.push("extract");
      return [
        { itemId: "file:1", fileId: 1, name: "Heaps", role: "lecture", pages: [{ page: 1, text: "Binary heaps" }, { page: 2, text: "Insert sifts up" }] },
        { itemId: "syllabus:7", fileId: null, name: "Syllabus", role: "syllabus", pages: [{ page: 1, text: "Exam 2 covers heaps." }] },
      ];
    },
    embed: async (chunks) => {
      calls.push("embed");
      return { texts: chunks.length };
    },
    findExams: async () => {
      calls.push("exams");
      return { exams: [exam("exam:exam-1", "Exam 1", "2026-10-06"), exam("exam:exam-2", "Exam 2", "2026-11-18", ["heaps"]), exam("exam:quiz-8", "Quiz 8", "2026-10-30")], checked: { proposed: 3, refusedFields: 0, prompt: "syllabus-parse@1" } };
    },
    generate: async (input) => {
      calls.push(`generate:${input.exams.map((e) => e.id).join(",")}`);
      return { questions: [question("q1", null), question("q2", null)], results: [{ group: "heaps", status: "kept", attempts: 1 }, { group: "heaps", status: "kept", attempts: 2 }] };
    },
    retrieve: async (qs) => {
      calls.push("retrieve");
      return qs.map((q, i) => (i === 0 ? question(q.id, { recordingUrl: "https://ufl.zoom.us/rec/play/r1", start: 600 }) : q));
    },
    cost: async () => ({ geminiUsd: 0.01, claudeUsd: 0.5 }),
    now: () => new Date("2026-10-23T22:00:00Z"),
  };
  return { deps, calls, files };
}

describe("runPipeline", () => {
  it("runs every stage in order and writes each stage's file", async () => {
    const f = fakeDeps();
    const r = await runPipeline({ exp, items, transcripts: [] }, f.deps);
    expect(f.calls).toEqual(["download", "extract", "embed", "exams", "generate:exam:exam-2", "retrieve"]);
    expect(r.ran).toEqual(["download", "extract", "chunk", "embed", "exams", "generate", "retrieve", "output"]);
    expect([...f.files.keys()].sort()).toEqual([...Object.values(STAGE_FILES), MANIFEST_FILE].sort());
    expect(Object.keys(JSON.parse(f.files.get(MANIFEST_FILE)!).stages)).toEqual(r.ran);
    expect(r.output.counts).toEqual({ docs: 2, chunks: 3, exams: 3, questions: 2, withClip: 1, withSlide: 2 });
    expect(r.output.cost).toEqual({ geminiUsd: 0.01, claudeUsd: 0.5 });
    expect(JSON.parse(f.files.get("output.json")!).course).toEqual({ id: 7, code: "FAKE7", name: "Fake DS" });
  });

  it("is resumable: a second run loads every stage; `from` reruns that stage and the rest", async () => {
    const first = fakeDeps();
    await runPipeline({ exp, items, transcripts: [] }, first.deps);
    const again = fakeDeps(first.files);
    const r2 = await runPipeline({ exp, items, transcripts: [] }, again.deps);
    expect(again.calls).toEqual([]);
    expect(r2.ran).toEqual([]);
    expect(r2.output.counts.questions).toBe(2);

    const third = fakeDeps(first.files);
    const r3 = await runPipeline({ exp, items, transcripts: [], from: "retrieve" }, third.deps);
    expect(third.calls).toEqual(["retrieve"]);
    expect(r3.ran).toEqual(["retrieve", "output"]);
  });

  it("a missing stage file reruns that stage and every later one", async () => {
    const first = fakeDeps();
    await runPipeline({ exp, items, transcripts: [] }, first.deps);
    first.files.delete("exams.json");
    const again = fakeDeps(first.files);
    const r = await runPipeline({ exp, items, transcripts: [] }, again.deps);
    expect(again.calls).toEqual(["exams", "generate:exam:exam-2", "retrieve"]);
    expect(r.ran).toEqual(["exams", "generate", "retrieve", "output"]);
  });

  it("never trusts a stage file this runner didn't record (e.g. another script's questions.json)", async () => {
    const files = new Map([["questions.json", "[]"], ["downloads.json", "[]"]]);
    const f = fakeDeps(files);
    const r = await runPipeline({ exp, items, transcripts: [] }, f.deps);
    expect(f.calls[0]).toBe("download");
    expect(r.output.counts.questions).toBe(2);
  });

  it("a rerun from an earlier stage drops the later stages from run.json until they finish", async () => {
    const first = fakeDeps();
    await runPipeline({ exp, items, transcripts: [] }, first.deps);
    const failing = fakeDeps(first.files);
    failing.deps.generate = async () => {
      throw new Error("budget");
    };
    await expect(runPipeline({ exp, items, transcripts: [], from: "exams" }, failing.deps)).rejects.toThrow("budget");
    expect(Object.keys(JSON.parse(first.files.get(MANIFEST_FILE)!).stages)).toEqual(["download", "extract", "chunk", "embed", "exams"]);
    const resumed = fakeDeps(first.files);
    await runPipeline({ exp, items, transcripts: [] }, resumed.deps);
    expect(resumed.calls).toEqual(["generate:exam:exam-2", "retrieve"]);
  });
});

describe("planRun: what a run will do, printed before anything runs", () => {
  const at = "2026-10-24T15:00:00.000Z";
  const all = (stages: readonly string[]) => ({ stages: Object.fromEntries(stages.map((s) => [s, { at }])) });
  const everything = all(["download", "extract", "chunk", "embed", "exams", "generate", "retrieve", "output"]);
  const has = () => true;
  const actions = (p: ReturnType<typeof planRun>) => p.map((x) => `${x.stage}:${x.action}`);

  it("a fresh course runs every stage", () => {
    expect(planRun({ stages: {} }, undefined, has).every((p) => p.action === "run")).toBe(true);
  });

  it("reuses saved stages before `from`, with the file and when it was saved; `from` and every later stage run", () => {
    const p = planRun(everything, "generate", has);
    expect(actions(p)).toEqual(["download:reuse", "extract:reuse", "chunk:reuse", "embed:reuse", "exams:reuse", "generate:run", "retrieve:run", "output:run"]);
    expect(p[4]).toEqual({ stage: "exams", action: "reuse", file: "exams.json", savedAt: at });
    expect(p[5]).toEqual({ stage: "generate", action: "run", file: "generated.json", savedAt: null });
  });

  it("once a stage runs (not in run.json, or its file is gone), every later one runs too", () => {
    expect(actions(planRun(all(["download", "extract", "embed", "exams"]), undefined, has)).filter((a) => a.endsWith("reuse"))).toEqual(["download:reuse", "extract:reuse"]);
    expect(actions(planRun(everything, undefined, (f) => f !== "chunks.json")).filter((a) => a.endsWith("reuse"))).toEqual(["download:reuse", "extract:reuse"]);
  });

  it("says loudly that stages are reused, and that nothing has run without --yes", () => {
    const lines = formatPlan(planRun(everything, "generate", has), false);
    expect(lines[0]).toBe("!!! REUSING 5 SAVED STAGES: download, extract, chunk, embed, exams");
    expect(lines).toContain("!!! Nothing has run. Check the plan below, then run again with --yes to go ahead.");
    expect(lines).toContain(`  exams     reuse exams.json (saved ${at})`);
    expect(lines).toContain("  generate  run");
    expect(formatPlan(planRun(everything, "generate", has), true).some((l) => l.includes("Nothing has run"))).toBe(false);
    // Nothing reused: no warning, just the plan.
    expect(formatPlan(planRun({ stages: {} }, undefined, has), false)[0]).toBe("Plan:");
  });

  it("is what runPipeline then does", async () => {
    const first = fakeDeps();
    await runPipeline({ exp, items, transcripts: [] }, first.deps);
    first.files.delete("embed.json");
    const plan = planRun(readManifest(first.files.get(MANIFEST_FILE)!), "retrieve", (f) => first.files.has(f));
    const again = fakeDeps(first.files);
    const r = await runPipeline({ exp, items, transcripts: [], from: "retrieve" }, again.deps);
    expect(r.ran).toEqual(plan.filter((p) => p.action === "run").map((p) => p.stage));
  });
});

describe("examsForPractice", () => {
  const now = new Date("2026-10-23T22:00:00Z");
  it("upcoming main exams only, when there are any", () => {
    const exams = [exam("e1", "Exam 1", "2026-10-06"), exam("e2", "Exam 2: Fall 2026", "2026-11-18"), exam("q8", "Quiz 8", "2026-10-30"), exam("f", "Final Exam", null)];
    expect(examsForPractice(exams, now).map((e) => e.id)).toEqual(["e2", "f"]);
  });
  it("otherwise every upcoming exam or quiz", () => {
    expect(examsForPractice([exam("q7", "Quiz 7", "2026-10-01"), exam("q8", "Quiz 8", "2026-10-30")], now).map((e) => e.id)).toEqual(["q8"]);
  });
});

describe("toPracticeSeed", () => {
  const r1 = "https://ufl.zoom.us/rec/play/r1";
  const r2 = "https://ufl.zoom.us/rec/play/r2";
  const transcript: PipelineTranscript = {
    id: "t1", source: "zoom", recordingUrl: r1, title: "Lecture, Oct 20", recordedAt: null, durationSec: 3600,
    segments: [
      { start: 560, end: 570, speaker: "Dr. Fake Lee", text: "Before the example." },
      { start: 575, end: 590, speaker: "Student", text: "A question." },
      { start: 600, end: 620, speaker: "Dr. Fake Lee", text: "Insert sifts up." },
      { start: 700, end: 710, speaker: "Dr. Fake Lee", text: "Much later." },
    ],
  };
  const output = (qs: PracticeQuestion[]): PipelineOutput => ({
    course: { id: 7, code: "FAKE7", name: "Fake DS" }, generatedAt: "x",
    counts: { docs: 0, chunks: 0, exams: 1, questions: qs.length, withClip: 0, withSlide: 0 },
    exams: [exam("exam:exam-2", "Exam 2", "2026-11-18")], questions: qs, transcripts: [], cost: { geminiUsd: 0, claudeUsd: 0 },
  });

  it("follows the recording most clips use; other clips fall back to their slide; no slide, no question", () => {
    const { seed, slides } = toPracticeSeed(
      output([question("a", { recordingUrl: r1, start: 600 }), question("b", { recordingUrl: r1, start: 650 }), question("c", { recordingUrl: r2, start: 100 }), { ...question("d", null, false), quoteSource: { kind: "lecture", itemId: "lecture:t1", recordingUrl: r1, start: 1, end: 2, title: "Lecture" } }]),
      [transcript],
    );
    expect(seed.recordingUrl).toBe(r1);
    expect(seed.questions.map((q) => [q.id, q.n, q.match.start])).toEqual([["a", 1, 600], ["b", 2, 650], ["c", 3, null]]);
    expect(seed.questions[0].match.slide).toEqual({ deck: "Heaps", page: 2, image: slideImageName("Heaps", 2, 1), canvasUrl: "https://ufl.instructure.com/courses/7/files/1#page=2" });
    expect(seed.questions[0].source).toEqual({ quote: "Insert sifts up", where: { kind: "slide", deck: "Heaps", page: 2 } });
    expect(slides).toEqual([{ deck: "Heaps", page: 2, fileId: 1, image: slideImageName("Heaps", 2, 1) }]);
    expect(seed).toMatchObject({ set: "Practice for Exam 2", lecturer: { name: "Dr. Fake Lee", short: "Lee" }, questionSet: "generated", lectureTitle: "Lecture, Oct 20" });
  });

  it("segments: the lecturer's lines from the example's start to just after the clip", () => {
    const { seed } = toPracticeSeed(output([question("a", { recordingUrl: r1, start: 600 })]), [transcript]);
    expect(seed.questions[0].segments.map((s) => s.start)).toEqual([600]);
    const early = toPracticeSeed(output([{ ...question("a", { recordingUrl: r1, start: 600 }), retrieval: { ...question("a", { recordingUrl: r1, start: 600 }).retrieval, clip: { ...question("a", { recordingUrl: r1, start: 600 }).retrieval.clip!, exampleStart: 560 } } }]), [transcript]);
    expect(early.seed.questions[0].segments.map((s) => s.text)).toEqual(["Before the example.", "Insert sifts up."]);
  });
});

describe("generated sets span lectures (the e2e fixture, invented text)", () => {
  const { seed } = toPracticeSeed(fixtureOutput, fixtureTranscripts);
  const [code, none, other] = seed.questions;

  it("a clip in another lecture keeps its clip, names its recording and takes its captions from that lecture", () => {
    expect(seed.recordingUrl).toBe(fixtureTranscripts[0].recordingUrl);
    expect(code.match.recordingUrl).toBeUndefined();
    expect(other.match).toMatchObject({ start: 300, end: 330, recordingUrl: fixtureTranscripts[1].recordingUrl });
    expect(other.segments.map((s) => s.start)).toEqual([300, 314, 330]);
  });

  it("captions are the lecturer's lines only; a question with no clip has none and no recording", () => {
    expect(code.segments.every((s) => s.speaker === "Dr. Fake Lee")).toBe(true);
    expect(none.match).toMatchObject({ start: null, end: null });
    expect(none.match.recordingUrl).toBeUndefined();
    expect(none.segments).toEqual([]);
  });

  it("a document page is marked as a page, a deck slide isn't; code carries through", () => {
    expect(none.match.slide.kind).toBe("page");
    expect(code.match.slide.kind).toBeUndefined();
    expect(code.code?.lines).toEqual(fixtureOutput.questions[0].code!.lines);
  });

  it("the slide shown is the retrieval's pick (the quote's page, unless the lecture-deck rule moved it)", () => {
    const [code, notes] = fixtureOutput.questions;
    const moved = (q: typeof code) => ({ ...q, retrieval: { ...q.retrieval, slide: { ...q.retrieval.slide!, page: 9 } } });
    const seedOf = (q: typeof code) => toPracticeSeed({ ...fixtureOutput, questions: [moved(q)] }, fixtureTranscripts).seed.questions[0];
    expect(seedOf(notes).match.slide.page).toBe(9); // quoted from page 2 of the notes, re-picked to page 9
    expect(seedOf(code).match.slide.page).toBe(9);
    expect(seedOf(notes).match.slide.page).not.toBe(notes.quoteSource.kind === "document" ? notes.quoteSource.page : -1);
  });

  it("slide or page by the rendered page's shape: a PDF of slides is a slide, whatever the source kind", () => {
    const image = slideImageName("Fake Course Notes", 2, 102);
    expect(toPracticeSeed(fixtureOutput, fixtureTranscripts, { [image]: "slide" }).seed.questions[1].match.slide.kind).toBeUndefined();
    expect(toPracticeSeed(fixtureOutput, fixtureTranscripts, { [image]: "page" }).seed.questions[1].match.slide.kind).toBe("page");
    const png = (w: number, h: number) => {
      const b = new Uint8Array(24);
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(b.buffer).setUint32(16, w);
      new DataView(b.buffer).setUint32(20, h);
      return b;
    };
    expect(pageKindOfPng(png(1600, 900))).toBe("slide");
    expect(pageKindOfPng(png(1600, 2070))).toBe("page");
    expect(pageKindOfPng(new Uint8Array(10))).toBeNull();
  });

  it("a question quoting a Canvas page is exported with its page (Page + the quoted words, no image) and no clip", () => {
    const { seed, slides } = toPracticeSeed(fixtureOutput, fixtureTranscripts);
    const q = seed.questions.find((x) => x.id === "q-canvas-page")!;
    expect(q.match.slide).toEqual({ deck: "Fake Lesson 3", page: 0, image: "", kind: "page", excerpt: "a vector made of two numbers is called a pair", canvasUrl: "https://ufl.instructure.com/courses/7/pages/fake-lesson-3" });
    expect(q.match).toMatchObject({ start: null, end: null });
    expect(slides.some((s) => s.deck === "Fake Lesson 3")).toBe(false); // nothing to render
    // Even with a clip it has no rewind screen to show it on, so the clip isn't exported.
    const withClip = { ...fixtureOutput, questions: fixtureOutput.questions.map((x) => (x.id === "q-canvas-page" ? { ...x, retrieval: { ...x.retrieval, clip: fixtureOutput.questions[0].retrieval.clip } } : x)) };
    expect(toPracticeSeed(withClip, fixtureTranscripts).seed.questions.find((x) => x.id === "q-canvas-page")!.match.start).toBeNull();
  });

  it("a clip whose lecture transcript isn't loaded falls back to its slide", () => {
    const only = toPracticeSeed(fixtureOutput, [fixtureTranscripts[0]]).seed.questions[2];
    expect(only.match).toMatchObject({ start: null, end: null });
  });
});

describe("slide images", () => {
  it("the older name of a new-style slide name (the dev route's fallback)", () => {
    expect(legacySlideName(slideImageName("Heaps", 2, 1))).toBe("heaps-p2.png");
    expect(legacySlideName("heaps-p2.png")).toBeNull();
    expect(legacySlideName("../x-1a2b3c4d-p1.png")).toBeNull();
  });

  const SERVED = /^[a-z0-9-]+\.png$/; // what app/api/dev-slides serves

  it("decks whose names slug alike never share an image", () => {
    const names = [slideImageName("Heaps & Tries", 2, 10), slideImageName("Heaps / Tries", 2, 11), slideImageName("Heaps-Tries", 2, 12), slideImageName("Heaps & Tries", 3, 10)];
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(SERVED);
    expect(slideImageName("Heaps & Tries", 2, 10)).toBe(slideImageName("Heaps & Tries", 2, 10)); // stable
  });

  it("a very long or symbol-only deck name still gives a short, servable file name", () => {
    for (const deck of ["Lecture ".repeat(80), "日本語のスライド", "!!!"]) {
      const n = slideImageName(deck, 123, 99);
      expect(n).toMatch(SERVED);
      expect(Buffer.byteLength(n)).toBeLessThanOrEqual(100);
    }
  });

  it("a damaged slides-rendered.json means render again, never a crash", () => {
    for (const bad of ["", "{", "null", "[]", '"x"', "42"]) expect(parseRenderedManifest(bad), bad).toBeNull();
    expect(parseRenderedManifest('{"a-1-p1.png":"5:x:p1","b":7}')).toEqual({ "a-1-p1.png": "5:x:p1" });
    // The script reads the manifest only through the parser (no bare JSON.parse that could throw).
    const src = readFileSync(join(process.cwd(), "scripts/pipeline/run.ts"), "utf8");
    expect(src).toMatch(/parseRenderedManifest\(/);
    expect(src).not.toMatch(/JSON\.parse\([^)]*RENDERED/);
  });

  it("re-renders when the image is missing or its deck changed, not otherwise", () => {
    const rendered = { "heaps-1a2b3c4d-p2.png": "100:abc:p2" };
    expect(slideNeedsRender(rendered, "heaps-1a2b3c4d-p2.png", "100:abc:p2", true)).toBe(false);
    expect(slideNeedsRender(rendered, "heaps-1a2b3c4d-p2.png", "120:def:p2", true)).toBe(true);
    expect(slideNeedsRender(rendered, "heaps-1a2b3c4d-p2.png", "100:abc:p2", false)).toBe(true);
    expect(slideNeedsRender({}, "graphs-00000000-p1.png", "5:x:p1", true)).toBe(true);
  });
});
