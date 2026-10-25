// Which chips may show (lib/tutor/poll.ts safeChips, used by tutorReply): never a chip whose quote gives the answer
// away before the student answers or on graded work, never a poll or answer slide before answering, no hint chips on
// graded work, none on a hint replaced for leaking. Invented course text, plus the committed demo bundle by reference.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { sanitizeSaved, validateSaved } from "../demo/tutor-saved";
import { readDemoBundle, type DemoBundle } from "../demo/bundle";
import type { PracticeSeed, SeedQuestion } from "../demo/types";
import { fakeTutor } from "./fake";
import { revealsAnswer } from "./integrity";
import { explanationWindow, isAnswerSlide, ownSlide, safeChips } from "./poll";
import { tutorReply } from "./service";

const LINE = "A min heap keeps the smallest value at the root of the tree.";
const SLIDE = "A push puts the new value in the next free slot at the bottom.";

const question = {
  id: "p",
  n: 1,
  stem: "Where does a pushed value that is smaller than everything end up?",
  choices: [
    { label: "A", text: "To the top position" },
    { label: "B", text: "At the bottom" },
    { label: "C", text: "Halfway down" },
    { label: "D", text: "It is dropped" },
  ],
  answer: "A",
  explanation: "It climbs while it is smaller than its parent.",
  source: { quote: SLIDE, where: { kind: "slide", deck: "5 - Heaps", page: 14 } },
  segments: [{ start: 100, end: 110, speaker: "Dr. Fake Lee", text: LINE }],
  match: { start: 100, end: 140, slide: { deck: "5 - Heaps", page: 14, image: "heaps-14.png" } },
} as unknown as SeedQuestion;
const seedOf = (questions: SeedQuestion[]) => ({ course: { code: "FAKE7", name: "Fake Data Structures" }, set: "Fake", lecturer: { name: "Dr. Fake Lee", short: "Lee" }, recordingUrl: "https://example.test/r", questions }) as unknown as PracticeSeed;
const call = (over: object = {}) => ({ seed: seedOf([question]), question, graded: false, request: "hint" as const, history: [], marked: null, ...over });
const says = (text: string, quotes: string[] = []) => async () => ({ text, claims: quotes.map((quote) => ({ quote })), confirms: false });

describe("isAnswerSlide", () => {
  it("is a slide marked revealsAnswer, or one whose own words make it a poll or an answer slide", () => {
    expect(isAnswerSlide({ revealsAnswer: true })).toBe(true);
    expect(isAnswerSlide({}, "Poll question #3: which index?")).toBe(true);
    expect(isAnswerSlide({}, "Answer: the root")).toBe(true);
    expect(isAnswerSlide({}, "Solution")).toBe(true);
    expect(isAnswerSlide({}, SLIDE)).toBe(false);
  });
});

describe("chips on a hint", () => {
  it("before answering: never the explanation moment nor the question's own source slide", async () => {
    // LINE is at 100 s, the start of the explanation window (match 100 to 140): not before the student answers.
    const r = await tutorReply(call(), says("Where does a new value go first?"));
    expect(r.grounded).toEqual([]);
    const own = await tutorReply(call(), says("Where does a new value go first?", [SLIDE]));
    expect(own.grounded.filter((g) => g.kind === "slide")).toEqual([]);
  });

  it("never a chip whose quote gives the answer away", async () => {
    const leaky = { ...question, segments: [{ start: 100, end: 110, speaker: "Dr. Fake Lee", text: "So the new value always ends up in the top position there." }] } as SeedQuestion;
    const r = await tutorReply(call({ question: leaky, seed: seedOf([leaky]) }), says("Where does a new value go first?"));
    expect(r.grounded).toEqual([]);
  });

  it("none on a hint replaced for leaking", async () => {
    const r = await tutorReply(call(), says("It's (A), the top position.", [LINE]));
    expect(r.rewritten).toBe(true);
    expect(r.grounded).toEqual([]);
  });

  it("never a poll or answer slide before answering, marked or by its words; after answering, practice may show it", async () => {
    const marked = { ...question, match: { ...question.match, slide: { ...question.match.slide, revealsAnswer: true } } } as SeedQuestion;
    const g = [{ kind: "slide" as const, quote: SLIDE, deck: "5 - Heaps", page: 14, pageKind: "slide" as const }];
    expect(safeChips(g, marked, { answered: false, graded: false, hint: false })).toEqual([]);
    expect(safeChips([{ ...g[0], quote: "Poll results for the push question", page: 3 }], question, { answered: false, graded: false, hint: false })).toEqual([]);
    expect(safeChips(g, marked, { answered: true, graded: false, hint: false })).toEqual(g);
  });

  it("graded work: no chips at all, on every path, answered or not", async () => {
    const gr = await tutorReply(call({ graded: true, request: "reply", message: "where do I start?" }), says("What does a push do first?", [LINE]));
    expect(gr.grounded).toEqual([]);
    const fine = [{ kind: "lecture" as const, quote: LINE, start: 100 }];
    for (const answered of [false, true]) for (const hint of [false, true]) expect(safeChips(fine, question, { answered, graded: true, hint })).toEqual([]);
  });

  it("the question's own slide never shows before answering, in any mode; after answering, on practice, it may", async () => {
    const own = [{ kind: "slide" as const, quote: SLIDE, deck: "5 - Heaps", page: 14, pageKind: "slide" as const }];
    for (const hint of [false, true]) expect(safeChips(own, question, { answered: false, graded: false, hint })).toEqual([]);
    const reply = await tutorReply(call({ request: "reply", message: "I'm stuck" }), says("What happens first?", [SLIDE]));
    expect(reply.grounded.filter((g) => g.kind === "slide")).toEqual([]);
    expect(safeChips(own, question, { answered: true, graded: false, hint: false })).toEqual(own);
  });
});

describe("the demo's poll and answer slides", () => {
  let bundle: DemoBundle;
  beforeAll(async () => {
    bundle = (await readDemoBundle())!;
  });
  // Their slide quote is the answer (coordinator review on PR #3).
  for (const id of ["l20261013-q2", "l20261020-q3"]) {
    it(`${id}: a hint before marking shows no slide chip and no answer in any chip's quote (its title and aria-label)`, async () => {
      const set = bundle.sets.find((s) => s.seed.questions.some((q) => q.id === id))!;
      const q = set.seed.questions.find((x) => x.id === id)!;
      const right = q.choices.find((c) => c.label === q.answer)!.text;
      for (const history of [[], [{ role: "tutor" as const, text: "Think about it.", kind: "hint" as const }]]) {
        // The fake model quotes the slide and a lecture line, the way a careful model would.
        const r = await tutorReply({ seed: set.seed, question: q, graded: false, request: "hint", history, marked: null }, fakeTutor(q, { delayMs: 0 }));
        expect(r.mode).toBe("hint");
        expect(r.grounded.filter((g) => g.kind === "slide")).toEqual([]);
        for (const g of r.grounded) {
          expect(revealsAnswer(g.quote, q), g.quote).toBe(false);
          expect(g.quote).not.toContain(right);
        }
      }
    });
  }
});


describe("John's rule on hints: the explanation moment unlocks only after the student answers", () => {
  const INTRO = "Today we start on heaps, a tree shaped structure we keep in an array.";
  const EXPLAIN_1 = "Watch the new value, it moves up the tree one swap at a time here.";
  const EXPLAIN_2 = "It keeps climbing while it is smaller than the value above it.";
  const q = {
    ...question,
    segments: [
      { start: 40, end: 50, speaker: "Dr. Fake Lee", text: INTRO },
      { start: 100, end: 110, speaker: "Dr. Fake Lee", text: EXPLAIN_1 },
      { start: 110, end: 120, speaker: "Dr. Fake Lee", text: EXPLAIN_2 },
    ],
  } as SeedQuestion;
  const hintCall = (marked: "B" | null) => ({ seed: seedOf([q]), question: q, graded: false, request: "hint" as const, history: [], marked });
  const quotesEverything = says("What does the lecture say first?", [INTRO, EXPLAIN_1, EXPLAIN_2]);

  it("a hint before answering may link an earlier moment where he introduces the idea, never one inside the window", async () => {
    const r = await tutorReply(hintCall(null), quotesEverything);
    expect(r.grounded).toEqual([{ kind: "lecture", quote: INTRO, start: 40 }]);
    // The model quoted nothing: the fallback is the introduction too.
    const fallback = await tutorReply(hintCall(null), says("What does the lecture say first?"));
    expect(fallback.grounded).toEqual([{ kind: "lecture", quote: INTRO, start: 40 }]);
  });

  it("an earlier moment that gives the answer away is no fallback: then no lecture chip", async () => {
    const leaky = { ...q, segments: [{ start: 40, end: 50, speaker: "Dr. Fake Lee", text: "Spoiler for later: it ends up in the top position every time." }, ...q.segments.slice(1)] } as SeedQuestion;
    const r = await tutorReply({ ...hintCall(null), question: leaky, seed: seedOf([leaky]) }, says("What happens first?"));
    expect(r.grounded).toEqual([]);
  });

  it("after answering, the explanation moment unlocks", async () => {
    const r = await tutorReply(hintCall("B"), says("What does the lecture say first?"));
    expect(r.grounded.some((g) => g.kind === "lecture" && g.start >= 100 && g.start <= 140)).toBe(true);
  });

  it("no pre-answer hint chip's timestamp falls inside the question's explanation window: every demo question, both hints, a model that quotes every line", async () => {
    const bundle = (await readDemoBundle())!;
    let hints = 0;
    for (const set of bundle.sets) {
      for (const dq of set.seed.questions) {
        const win = explanationWindow(dq)!;
        const allLines = dq.segments.map((s) => s.text);
        for (const history of [[], [{ role: "tutor" as const, text: "Think about it.", kind: "hint" as const }]]) {
          for (const generate of [says("What does the lecture say first?", allLines), fakeTutor(dq, { delayMs: 0 })]) {
            const r = await tutorReply({ seed: set.seed, question: dq, graded: false, request: "hint", history, marked: null }, generate);
            hints++;
            for (const g of r.grounded) {
              if (g.kind === "lecture") expect(g.start < win.start || g.start > win.end, `${dq.id} ${g.start} in ${win.start}-${win.end}`).toBe(true);
              else expect(ownSlide(g, dq) || g.revealsAnswer, `${dq.id} slide ${g.page}`).toBeFalsy();
            }
          }
        }
      }
    }
    expect(hints).toBeGreaterThan(100);
  });
});

describe("the demo's two poll/answer slides and the saved replies", () => {
  const POLL = ["l20261013-q2", "l20261020-q3"];
  it("are marked revealsAnswer in the bundle", async () => {
    const bundle = (await readDemoBundle())!;
    const qs = new Map(bundle.sets.flatMap((s) => s.seed.questions.map((q) => [q.id, q] as const)));
    for (const id of POLL) expect(qs.get(id)!.match.slide.revealsAnswer, id).toBe(true);
    expect([...qs.values()].filter((q) => q.match.slide.revealsAnswer).map((q) => q.id).sort()).toEqual(POLL);
  });

  it("in reply mode too, before answering, they show no slide chip and no answer in any chip", async () => {
    const bundle = (await readDemoBundle())!;
    for (const id of POLL) {
      const set = bundle.sets.find((s) => s.seed.questions.some((q) => q.id === id))!;
      const q = set.seed.questions.find((x) => x.id === id)!;
      const r = await tutorReply({ seed: set.seed, question: q, graded: false, request: "reply", message: "I'm not sure", history: [], marked: null }, says("What do you notice?", [q.source!.quote, ...q.segments.map((s) => s.text)]));
      expect(r.grounded.filter((g) => g.kind === "slide")).toEqual([]);
      for (const g of r.grounded) expect(revealsAnswer(g.quote, q)).toBe(false);
    }
  });

  it("the committed tutor.json passes the rule (no chip the page couldn't show), and sanitizing it again changes nothing", async () => {
    const bundle = (await readDemoBundle())!;
    const file = JSON.parse(readFileSync("public/demo/course/tutor.json", "utf8"));
    expect(validateSaved(file, bundle)).toEqual([]);
    expect(sanitizeSaved(file, bundle)).toEqual(file);
    for (const id of POLL) for (const kind of ["hint1", "hint2", "socratic", "confirm"]) expect(file.questions[id][kind].grounded, `${id}.${kind}`).toEqual([]);
  });
});
