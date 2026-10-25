import { describe, expect, it } from "vitest";
import { LLM_MODELS, type ModelRef } from "../llm";
import { MODELS } from "../gemini";
import type { TranscriptSegment } from "../schema";
import { LECTURE_SLIDE_MIN } from "./lecture-slides";
import { buildIndex, checkSetup, extendEnd, keyTerms, labelTime, lectureDecks, lectureForDeck, lecturerRuns, MAX_CLIP_SEC, questionLecture, questionText, retrieveOne, termCoverage } from "./retrieve";
import type { PipelineChunk, PipelineTranscript } from "./types";

const PROF = "Prof";
const seg = (start: number, text: string, speaker = PROF): TranscriptSegment => ({ start, end: start + 5, speaker, text });

// The prof talks 0-100 s about hashing (his last line runs into the guest), a guest speaks at 100 s, the prof goes on at 130 s about graphs.
const segments = [
  ...Array.from({ length: 20 }, (_, i) => seg(i * 5, i < 6 ? "Now let me open the hash table example." : `We hash each key with mod seven, line ${i}.`)).map((x) => (x.start === 95 ? { ...x, end: 110 } : x)),
  seg(100, "Guest talk about internships.", "Guest"),
  seg(105, "More guest talk.", "Guest"),
  ...Array.from({ length: 10 }, (_, i) => seg(130 + i * 5, "An undirected graph is connected if there is a path between every pair.")),
];
const TRANSCRIPT: PipelineTranscript = { id: "oct22", source: "zoom", recordingUrl: "https://ufl.zoom.us/rec/play/x", title: "Oct 22", recordedAt: null, durationSec: 200, segments };

const slide = (page: number, text: string): PipelineChunk => ({ id: `d#${page}`, text, role: "lecture", source: { kind: "slide", itemId: "file:1", fileId: 1, page, deck: "7 - Hashing" } });
const CHUNKS = [slide(1, "Hash tables and collisions"), slide(2, "Graphs: connected components")];

const QUESTION = {
  stem: "Keys are hashed with mod 7. Which keys collide?",
  code: null,
  choices: (["A", "B", "C", "D"] as const).map((label, i) => ({ label, text: ["1 and 8", "2 and 3", "4 and 5", "6 and 7"][i] })),
};

/** Vectors: hashing text points one way, graph text the other. */
const embed = async (texts: string[]) => texts.map((t) => (/hash|mod|collide/i.test(t) ? [1, 0.1] : [0.1, 1]));

function fakeLLM(replies: { setup?: object[]; pick?: object; slide?: object }) {
  const calls: { kind: string; model: ModelRef; prompt: string }[] = [];
  let setups = 0;
  return {
    calls,
    llm: {
      async generateJSON<T>(model: ModelRef, prompt: string): Promise<T> {
        const kind = prompt.startsWith("A student is practicing") ? "rewrite" : prompt.startsWith("A student will hear") ? "setup" : prompt.includes("candidate passages") ? "pick" : "slide";
        calls.push({ kind, model, prompt });
        if (kind === "rewrite") return { concept: "hashing collisions", explanation: "We hash keys with mod and keys collide." } as T;
        if (kind === "pick") return (replies.pick ?? { candidate: 1, startLabel: "0:30", endLabel: "1:35", confidence: "high", reason: "r" }) as T;
        if (kind === "setup") return (replies.setup ?? [{ exampleLine: 0, setup: "He opens the hash table example.", sourceLines: [0, 1] }])[Math.min(setups++, (replies.setup?.length ?? 1) - 1)] as T;
        return (replies.slide ?? { option: 1, reason: "r" }) as T;
      },
    },
  };
}

describe("buildIndex", () => {
  it("searches only the lecturer, in windows that never span another speaker", async () => {
    const index = await buildIndex([TRANSCRIPT], CHUNKS, { embed });
    expect(index.windows.every((w) => w.segments.every((s) => s.speaker === PROF))).toBe(true);
    expect(index.windows.every((w) => w.segments.every((x) => x.start < 100) || w.segments.every((x) => x.start >= 130))).toBe(true);
    expect(lecturerRuns(segments, PROF)).toHaveLength(2);
  });
});

describe("retrieveOne", () => {
  it("picks the moment with Flash, stops the clip before the guest, and writes the setup line with the configured setup model", async () => {
    const index = await buildIndex([TRANSCRIPT], CHUNKS, { embed });
    // Candidate 2 is the hashing window at 40 s; its lines run to the guest.
    const { llm, calls } = fakeLLM({ pick: { candidate: 2, startLabel: "0:30", endLabel: "1:35", confidence: "high", reason: "r" } });
    const r = await retrieveOne(QUESTION, index, { courseCode: "COP3530", llm, embed });
    const clip = r.retrieval.clip!;
    expect(clip).toMatchObject({ transcriptId: "oct22", recordingUrl: TRANSCRIPT.recordingUrl, start: 30, exampleStart: 0, setup: "He opens the hash table example.", sourceLines: [0, 1] });
    // The 1:35 line runs to 110 s, but the guest starts at 100 s.
    expect(clip.end).toBe(100);
    expect(clip.end - clip.start).toBeLessThanOrEqual(MAX_CLIP_SEC);
    expect(r.retrieval).toMatchObject({ slide: CHUNKS[0].source, fallback: null });
    expect(calls.map((c) => [c.kind, c.model.model])).toEqual([
      ["rewrite", MODELS.flash],
      ["pick", MODELS.flash],
      ["setup", LLM_MODELS.setupLines.model],
      ["slide", MODELS.flash],
    ]);
    expect(r.prompts).toEqual({ "setup-line": "setup-line@2" });
  });

  it("drops a setup line with numbers after one retry naming them", async () => {
    const index = await buildIndex([TRANSCRIPT], CHUNKS, { embed });
    const bad = { exampleLine: 0, setup: "He hashes seven keys.", sourceLines: [0] };
    const { llm, calls } = fakeLLM({ setup: [bad, bad] });
    const r = await retrieveOne(QUESTION, index, { courseCode: "COP3530", llm, embed });
    expect(r.retrieval.clip!.setup).toBeNull();
    expect(r.retrieval.clip!.sourceLines).toEqual([]);
    expect(calls.filter((c) => c.kind === "setup")[1].prompt).toContain("the number seven");
  });

  it("falls back to the slide when no moment explains it, or there is no recording", async () => {
    const index = await buildIndex([TRANSCRIPT], CHUNKS, { embed });
    const { llm } = fakeLLM({ pick: { candidate: 0, startLabel: "", endLabel: "", confidence: "low", reason: "none" } });
    expect((await retrieveOne(QUESTION, index, { courseCode: "COP3530", llm, embed })).retrieval).toMatchObject({ clip: null, fallback: "slide" });
    const noTape = await buildIndex([], CHUNKS, { embed });
    expect((await retrieveOne(QUESTION, noTape, { courseCode: "COP3530", llm, embed })).retrieval).toMatchObject({ clip: null, slide: CHUNKS[0].source, fallback: "slide" });
  });

  it("falls back to a reading, or to nothing", async () => {
    const reading: PipelineChunk = { id: "r", text: "Hashing chapter", role: "lecture", source: { kind: "document", itemId: "file:2", fileId: 2, page: 4, name: "Notes" } };
    const { llm } = fakeLLM({});
    expect((await retrieveOne(QUESTION, await buildIndex([], [reading], { embed }), { courseCode: "C", llm, embed })).retrieval).toMatchObject({ clip: null, fallback: "reading" });
    expect((await retrieveOne(QUESTION, await buildIndex([], [], { embed }), { courseCode: "C", llm, embed })).retrieval).toEqual({ clip: null, slide: null, fallback: "none" });
  });
});

describe("helpers", () => {
  it("reads Flash's time labels", () => {
    expect(labelTime("43:40")).toBe(2620);
    expect(labelTime("[1:02:15]")).toBe(3735);
    expect(labelTime("soon")).toBeNull();
  });

  it("puts code in the question text", () => {
    expect(questionText({ ...QUESTION, code: { language: "cpp", lines: ["a;", "b;"], source: CHUNKS[0].source } })).toContain("collide?\na;\nb;\n(A) 1 and 8");
  });

  it("checks a setup line: grounded, cited, no numbers, at most 35 words", () => {
    const before = segments.slice(0, 6).map((s, id) => ({ id, seg: s }));
    expect(checkSetup({ exampleLine: 0, setup: "He opens the hash table example.", sourceLines: [0] }, before).ok).toBe(true);
    expect(checkSetup({ exampleLine: 0, setup: "He opens the whiteboard.", sourceLines: [0] }, before).ok).toBe(false);
    expect(checkSetup({ exampleLine: 0, setup: "He opens the hash table example.", sourceLines: [] }, before).ok).toBe(false);
    expect(checkSetup({ exampleLine: 0, setup: "He opens the hash table example. ".repeat(6), sourceLines: [0] }, before).ok).toBe(false);
  });
});

describe("clip choice by the question's key terms (reviewer's clip check, Oct 24)", () => {
  const Q = { stem: "Keys A and E hash to the same bucket. Where does E go with separate chaining?", choices: (["A", "B", "C", "D"] as const).map((label, i) => ({ label, text: ["At the end of the bucket's chain", "In the next bucket", "Nowhere", "In a new table"][i] })), answer: "A" as const, quote: "E goes on the chain after A" };

  it("key terms are the question's distinctive words; coverage counts them in a passage", () => {
    const terms = keyTerms(Q);
    expect(terms).toEqual(expect.arrayContaining(["key", "hash", "bucket", "separate", "chaining", "chain"]));
    expect(terms).not.toContain("where");
    expect(termCoverage(terms, "now E collides with A in that bucket, so we chain it")).toBeGreaterThan(termCoverage(terms, "we insert A into the table"));
  });

  it("the end runs on through the lines right after it that still state the key terms", () => {
    const segs = [seg(100, "We hash E to bucket two."), seg(110, "Bucket two already has A."), seg(118, "So E is chained after A in bucket two's chain."), seg(126, "Okay, any questions?"), seg(160, "Hash and chain again later.")];
    expect(extendEnd(segs, 115, 175, keyTerms(Q))).toBe(123); // the chaining line, not the question or the far one
    expect(extendEnd(segs, 115, 120, keyTerms(Q))).toBe(115); // never past the cap
  });

  it("a setup about something else is replaced by one from the clip's own lines", async () => {
    const hashing: PipelineTranscript = { ...TRANSCRIPT, segments: [
      ...Array.from({ length: 8 }, (_, i) => seg(i * 5, "He shares his screen and talks about bubble sort.")),
      ...Array.from({ length: 12 }, (_, i) => seg(40 + i * 5, `Now E collides with A in the bucket, so we chain E after A, line ${i}.`)),
    ] };
    const index = await buildIndex([hashing], CHUNKS, { embed });
    const f = fakeLLM({
      pick: { candidate: 1, startLabel: "0:45", endLabel: "1:20", confidence: "high", reason: "r" },
      setup: [
        { exampleLine: 0, setup: "He shares his screen and talks about bubble sort.", sourceLines: [0, 1] },
        { exampleLine: 0, setup: "He shares his screen and talks about bubble sort.", sourceLines: [0, 1] },
        { exampleLine: -1, setup: "E collides with A in the bucket, so he chains E after A.", sourceLines: [9, 10] },
      ],
    });
    const r = await retrieveOne(Q, index, { courseCode: "FAKE7", llm: f.llm, embed, lecture: 0 });
    expect(r.retrieval.clip?.setup).toBe("E collides with A in the bucket, so he chains E after A.");
    expect(r.retrieval.clip?.exampleStart).toBeNull();
  });
});

describe("the question's own lecture (no clip beats a wrong clip)", () => {
  // Two invented lectures: one on hashing, one on graphs; decks for each, and one deck neither teaches.
  const hashing: PipelineTranscript = { ...TRANSCRIPT, id: "hash", recordingUrl: "https://ufl.zoom.us/rec/play/hash", segments: Array.from({ length: 12 }, (_, i) => seg(i * 5, `We hash each key with mod seven, line ${i}.`)) };
  const graphs: PipelineTranscript = { ...TRANSCRIPT, id: "graphs", recordingUrl: "https://ufl.zoom.us/rec/play/graphs", segments: Array.from({ length: 12 }, (_, i) => seg(i * 5, `A graph is connected when every pair has a path, line ${i}.`)) };
  const deck = (name: string, fileId: number, text: string): PipelineChunk => ({ id: `${name}#1`, text, role: "lecture", source: { kind: "slide", itemId: `file:${fileId}`, fileId, page: 1, deck: name } });
  const chunks = [deck("7 - Hashing", 7, "Hash tables and collisions"), deck("8 - Graphs", 8, "Graphs: connected components"), deck("2 - Lists", 2, "Linked lists")];
  /** Hash text, graph text and list text point three different ways. */
  const embed3 = async (texts: string[]) => texts.map((t) => (/hash|mod|collide/i.test(t) ? [1, 0.05, 0.05] : /graph|connected/i.test(t) ? [0.05, 1, 0.05] : [0.05, 0.05, 1]));
  const q = (deckName: string) => ({ ...QUESTION, topic: deckName, quoteSource: chunks.find((c) => (c.source as { deck: string }).deck === deckName)!.source });

  it("a deck is taught by the lecture that clearly scores highest; one no lecture teaches has none", async () => {
    const index = await buildIndex([hashing, graphs], chunks, { embed: embed3 });
    expect(questionLecture(q("7 - Hashing"), index).t).toBe(0);
    expect(questionLecture(q("8 - Graphs"), index).t).toBe(1);
    expect(questionLecture(q("2 - Lists"), index)).toEqual({ t: null, reason: 'no lecture clearly teaches "2 - Lists"' });
    expect(lectureForDeck([0.8, 0.79])).toBeNull(); // too close to call
    expect(lectureForDeck([0.7, 0.6])).toBeNull(); // not taught
    expect(lectureForDeck([0.6, 0.78])).toBe(1);
  });

  it("a question whose quote is from a lecture searches that lecture", async () => {
    const index = await buildIndex([hashing, graphs], chunks, { embed: embed3 });
    expect(questionLecture({ topic: "x", quoteSource: { kind: "lecture", itemId: "l", recordingUrl: graphs.recordingUrl, start: 5, end: 10, title: "G" } }, index).t).toBe(1);
  });

  it("no lecture: no clip and no moment pick; the slide is the page the quote is from", async () => {
    const index = await buildIndex([hashing, graphs], chunks, { embed: embed3 });
    const f = fakeLLM({});
    const r = await retrieveOne(q("2 - Lists"), index, { courseCode: "FAKE7", llm: f.llm, embed: embed3, lecture: null });
    expect(r.retrieval.clip).toBeNull();
    expect(r.retrieval.slide).toEqual(chunks[2].source);
    expect(r.retrieval.fallback).toBe("slide");
    expect(f.calls.map((c) => c.kind)).toEqual(["rewrite"]);
  });

  it("a quote from a Canvas page carries that page (no slide picked for it)", async () => {
    const index = await buildIndex([hashing, graphs], chunks, { embed: embed3 });
    const f = fakeLLM({});
    const page = { kind: "page" as const, itemId: "page:lesson-3", pageUrl: "lesson-3", title: "Lesson 3", href: "https://ufl.instructure.com/courses/7/pages/lesson-3" };
    const r = await retrieveOne({ ...QUESTION, quoteSource: page }, index, { courseCode: "FAKE7", llm: f.llm, embed: embed3, lecture: null });
    expect(r.retrieval).toEqual({ clip: null, slide: null, page, fallback: "reading" });
    expect(f.calls.some((c) => c.kind === "slide")).toBe(false);
  });

  it("with a lecture, only its windows are candidates", async () => {
    const index = await buildIndex([hashing, graphs], chunks, { embed: embed3 });
    const f = fakeLLM({ pick: { candidate: 1, startLabel: "0:10", endLabel: "0:40", confidence: "high", reason: "r" }, setup: [{ exampleLine: 0, setup: "He hashes each key with mod seven.", sourceLines: [0, 1] }] });
    const r = await retrieveOne(q("7 - Hashing"), index, { courseCode: "FAKE7", llm: f.llm, embed: embed3, lecture: 1 });
    expect(r.retrieval.clip?.recordingUrl).toBe(graphs.recordingUrl);
    expect(f.calls.find((c) => c.kind === "pick")!.prompt).not.toMatch(/We hash each key/);
  });

  describe("a lecture question shows only its lecture's numbered deck (John, Oct 24)", () => {
    const withDiscussion = [...chunks, deck("Discussion 9 - Hashing", 9, "Discussion: hash collisions"), deck("Discussion 3 - Lists", 3, "Discussion: linked lists")];
    const pick = { pick: { candidate: 1, startLabel: "0:10", endLabel: "0:40", confidence: "high", reason: "r" }, setup: [{ exampleLine: 0, setup: "Kapoor hashes each key with mod seven.", sourceLines: [0, 1] }] };

    it("lectureDecks: each lecture's numbered decks; Discussion decks are never one", async () => {
      const index = await buildIndex([hashing, graphs], withDiscussion, { embed: embed3 });
      expect(lectureDecks(index)).toEqual([["7 - Hashing"], ["8 - Graphs"]]);
    });

    it("a quote from a Discussion deck gets the lecture deck's closest page, never the Discussion page", async () => {
      const index = await buildIndex([hashing, graphs], withDiscussion, { embed: embed3 });
      const r = await retrieveOne({ ...QUESTION, quoteSource: withDiscussion[3].source }, index, { courseCode: "FAKE7", llm: fakeLLM(pick).llm, embed: embed3, lecture: 0, lectureDecks: ["7 - Hashing"] });
      expect(r.retrieval.slide).toEqual(chunks[0].source);
    });

    it("a quote from the lecture's own deck keeps its page; with no rule the Discussion page is kept as before", async () => {
      const index = await buildIndex([hashing, graphs], withDiscussion, { embed: embed3 });
      const own = await retrieveOne(q("7 - Hashing"), index, { courseCode: "FAKE7", llm: fakeLLM(pick).llm, embed: embed3, lecture: 0, lectureDecks: ["7 - Hashing"] });
      expect(own.retrieval.slide).toEqual(chunks[0].source);
      const free = await retrieveOne({ ...QUESTION, quoteSource: withDiscussion[3].source }, index, { courseCode: "FAKE7", llm: fakeLLM(pick).llm, embed: embed3, lecture: 0 });
      expect(free.retrieval.slide).toEqual(withDiscussion[3].source);
    });

    it("no page of the lecture's deck reaches the line: no slide, rather than an off-topic one", async () => {
      const index = await buildIndex([hashing, graphs], withDiscussion, { embed: embed3 });
      // The quote is about lists and the clip about hashing; the only allowed deck is about graphs: no page is close to both.
      const r = await retrieveOne({ ...QUESTION, quoteSource: withDiscussion[4].source }, index, { courseCode: "FAKE7", llm: fakeLLM(pick).llm, embed: embed3, lecture: 0, lectureDecks: ["8 - Graphs"] });
      expect(r.retrieval.slide).toBeNull();
      expect(r.debug.slideReason ?? "").toMatch(new RegExp(`reaches ${LECTURE_SLIDE_MIN}`));
    });
  });
});
