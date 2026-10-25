// "Give me a similar one" (lib/tutor/similar.ts) and the hint chips (lib/tutor/service.ts hintChips): new values only,
// a word-for-word source, refused on graded work before any model call, and the demo route's limits and fallback.
// Invented course text only (lib/real-text.test.ts keeps real text out of committed files); the demo cases read the
// committed demo bundle by reference.
import { beforeAll, describe, expect, it } from "vitest";
import type { PracticeSeed, SeedQuestion } from "../demo/types";
import { readDemoBundle, type DemoBundle } from "../demo/bundle";
import type { DemoModel } from "../demo/tutor-llm";
import { NO_SAVED_SIMILAR, pickSavedSimilar } from "../demo/tutor-pick";
import { precomputeTutor } from "../demo/tutor-precompute";
import { demoSigner, handleDemoTutor, type DemoTutorDeps } from "../demo/tutor-route";
import { validateSaved } from "../demo/tutor-saved";
import { memoryStore } from "../demo/tutor-store";
import { similarGaps, similarWarning } from "../demo/tutor-coverage";
import { topicRule, tutorPrompt, type SimilarJSON } from "../prompts/tutor";
import { fakeSimilar, fakeTutor } from "./fake";
import { reusesValues, sharedValues } from "./integrity";
import { explanationMoment, hintChips, tutorReply } from "./service";
import { similarInput, checkSimilar, MAX_CHOICE, MAX_STEM, SIMILAR_FAILED, SIMILAR_INTRO, SIMILAR_REFUSAL, similarQuestion, similarTurnText } from "./similar";
import { MAX_TURN_CHARS } from "./history";
import { inputOf } from "./service";
import { DEMO_SIMILAR_MAX_TOKENS, estimateMicro } from "../demo/tutor-llm";

const LINE_1 = "A hash table with more keys than slots must put two keys in one slot.";
const LINE_2 = "We call that a collision, and chaining keeps both keys in a list.";
const SLIDE_QUOTE = "With n keys and m slots, n greater than m forces a collision.";

const question: SeedQuestion = {
  id: "h1",
  n: 1,
  stem: "A table has 10 slots and 12 keys are inserted. What must happen?",
  choices: [
    { label: "A", text: "At least 2 keys share a slot" },
    { label: "B", text: "Every slot holds 12 keys" },
    { label: "C", text: "The table rejects 2 keys" },
    { label: "D", text: "No collisions happen" },
  ],
  answer: "A",
  explanation: "More keys than slots means two keys land in one slot.",
  source: { quote: SLIDE_QUOTE, where: { kind: "slide", deck: "7 - Hashing", page: 12 } },
  segments: [
    { start: 300, end: 310, speaker: "Dr. Fake Lee", text: LINE_1 },
    { start: 310, end: 322, speaker: "Dr. Fake Lee", text: LINE_2 },
  ],
  match: { start: 302, end: 340, slide: { deck: "7 - Hashing", page: 12, image: "x.png" } } as SeedQuestion["match"],
};
const seed = { course: { code: "FAKE7", name: "Fake Data Structures" }, set: "Fake set", lecturer: { name: "Dr. Fake Lee", short: "Lee" }, recordingUrl: "https://example.test/r", questions: [question] } as unknown as PracticeSeed;

const good: SimilarJSON = {
  stem: "A table has 6 slots and 9 keys are inserted. What must happen?",
  code: [],
  choices: [
    { label: "A", text: "Some slot holds two or more keys" },
    { label: "B", text: "Every slot holds 9 keys" },
    { label: "C", text: "The table rejects 3 keys" },
    { label: "D", text: "No collisions happen at all" },
  ],
  answer: "A",
  explanation: "Nine keys in six slots means some slot takes two.",
  quote: "more keys than slots must put two keys in one slot",
};
const gen = (raw: unknown) => async () => raw as SimilarJSON;

import { similarPrompt } from "../prompts/tutor";
const similarPromptOf = (c: Parameters<typeof similarInput>[0]) => similarPrompt(similarInput(c));

describe("sharedValues: the reusesValues rule without a trigger word", () => {
  it("finds the question's numbers in any text, and ignores 0 and 1", () => {
    expect(sharedValues("A table with 10 slots", question)).toEqual(["10"]);
    expect(sharedValues("12 keys, 1 slot, 0 left", question)).toEqual(["12"]);
    expect(sharedValues("6 slots and 9 keys", question)).toEqual([]);
    // Fullwidth digits and thousands commas don't hide one.
    expect(sharedValues("a table of １０ slots", question)).toEqual(["10"]);
    // reusesValues still needs its trigger word, as before.
    expect(reusesValues("Count the 10 slots first.", question)).toBe(false);
    expect(reusesValues("Here's a similar one with 10 slots.", question)).toBe(true);
  });
});

describe("checkSimilar: a new question, with new values and a word-for-word source", () => {
  it("keeps a sound one and links its source to the lecture moment", () => {
    const r = checkSimilar(good, question);
    expect(r).toHaveProperty("card");
    if (!("card" in r)) return;
    expect(r.card.source).toEqual({ kind: "lecture", quote: good.quote, start: 300 });
    expect(r.card.choices.map((c) => c.label)).toEqual(["A", "B", "C", "D"]);
    expect(r.card.code).toBeNull();
  });

  it("drops one that reuses any of the question's numbers: in the stem, a choice, the code or the explanation", () => {
    expect(checkSimilar({ ...good, stem: "A table has 10 slots and 9 keys are inserted. What must happen?" }, question)).toEqual({ problem: "values" });
    expect(checkSimilar({ ...good, choices: good.choices.map((c, i) => (i === 1 ? { ...c, text: "Every slot holds 12 keys" } : c)) }, question)).toEqual({ problem: "values" });
    expect(checkSimilar({ ...good, code: ["slots = 10"] }, question)).toEqual({ problem: "values" });
    expect(checkSimilar({ ...good, explanation: "Like 12 keys in 10 slots." }, question)).toEqual({ problem: "values" });
  });

  it("drops one whose source quote isn't word for word in the course material", () => {
    expect(checkSimilar({ ...good, quote: "more keys than slots puts two keys in a slot" }, question)).toEqual({ problem: "ungrounded" });
    expect(checkSimilar({ ...good, quote: "The professor said this is on the exam." }, question)).toEqual({ problem: "ungrounded" });
    // Too short to mean anything, even when it is in the text.
    expect(checkSimilar({ ...good, quote: "two keys" }, question)).toEqual({ problem: "ungrounded" });
    // The slide's own words count, and link to the slide.
    const slide = checkSimilar({ ...good, quote: "n greater than m forces a collision" }, question);
    expect("card" in slide && slide.card.source).toMatchObject({ kind: "slide", page: 12 });
  });

  it("drops one whose right answer is the question's own right answer", () => {
    const same = { ...good, choices: good.choices.map((c) => (c.label === "A" ? { ...c, text: "At least 2 keys share a slot" } : c)) };
    // (it also reuses 2, so give the value check nothing to find)
    expect(checkSimilar({ ...same, choices: same.choices.map((c) => (c.label === "A" ? { ...c, text: "At least two keys share a slot" } : c)) }, { ...question, choices: question.choices.map((c) => (c.label === "A" ? { ...c, text: "At least two keys share a slot" } : c)) })).toEqual({ problem: "same-answer" });
  });

  it("caps the stem and choices so the signed history text stays under MAX_TURN_CHARS", () => {
    expect(checkSimilar({ ...good, stem: `A table has 6 slots. ${"x".repeat(MAX_STEM)}` }, question)).toEqual({ problem: "shape" });
    expect(checkSimilar({ ...good, choices: good.choices.map((c, i) => (i ? c : { ...c, text: "y".repeat(MAX_CHOICE + 1) })) }, question)).toEqual({ problem: "shape" });
    const longest = { stem: "s".repeat(MAX_STEM), choices: (["A", "B", "C", "D"] as const).map((label) => ({ label, text: "c".repeat(MAX_CHOICE) })) };
    expect(similarTurnText(longest).length).toBeLessThan(MAX_TURN_CHARS);
  });

  it("drops the same question back, a bad shape, and duplicate choices", () => {
    expect(checkSimilar({ ...good, stem: question.stem }, question)).toEqual({ problem: "same" });
    expect(checkSimilar({ ...good, choices: good.choices.slice(0, 3) }, question)).toEqual({ problem: "shape" });
    expect(checkSimilar({ ...good, choices: good.choices.map((c) => ({ ...c, label: "A" })) }, question)).toEqual({ problem: "shape" });
    expect(checkSimilar({ ...good, choices: good.choices.map((c) => ({ ...c, text: "Same text" })) }, question)).toEqual({ problem: "shape" });
    expect(checkSimilar({ ...good, answer: "E" }, question)).toEqual({ problem: "shape" });
    expect(checkSimilar(null, question)).toEqual({ problem: "shape" });
  });
});

describe("similarQuestion", () => {
  it("refuses on graded work without calling the model", async () => {
    let called = false;
    const r = await similarQuestion({ seed, question, graded: true }, async () => ((called = true), good));
    expect(called).toBe(false);
    expect(r).toEqual({ text: SIMILAR_REFUSAL, card: null, refused: true });
  });

  it("on practice: sends the question, its key and the course text (nothing the student wrote), and returns the checked card", async () => {
    let sent = "";
    const r = await similarQuestion({ seed, question, graded: false, marked: "B" }, async (p) => ((sent = p), good));
    expect(r.text).toBe(SIMILAR_INTRO);
    expect(r.card?.stem).toBe(good.stem);
    expect(sent).toContain(question.stem);
    expect(sent).toContain("Correct answer: (A)");
    expect(sent).toContain(`[5:00] ${LINE_1}`);
    expect(sent).toContain("Use none of this question's numbers anywhere");
    expect(sent).toContain(topicRule());
    expect(sent).not.toContain("<student>");
  });

  it("before the student has answered, a card whose source quote gives the answer away isn't shown", async () => {
    // "two keys in one slot" states the answer to the question itself.
    const r = await similarQuestion({ seed, question, graded: false, marked: null }, gen(good));
    expect(r.card).toBeNull();
    expect(r.problem).toBe("reveals");
  });

  it("the live prompt names the original's values to avoid, and one failed try is retried while there is time", async () => {
    const bad = { ...good, stem: "A table has 10 slots and 9 keys." };
    const prompts: string[] = [];
    const seq = [bad, good];
    const r = await similarQuestion({ seed, question, graded: false, marked: "B" }, async (p) => (prompts.push(p), seq.shift()!), { retryUntil: 10, now: () => 0 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your first try was dropped");
    expect(r.card).not.toBeNull();
    // No time left: no retry, the failure stands.
    const once: string[] = [];
    const late = await similarQuestion({ seed, question, graded: false, marked: "B" }, async (p) => (once.push(p), bad), { retryUntil: 10, now: () => 11 });
    expect(once).toHaveLength(1);
    expect(late.card).toBeNull();
  });

  it("says so plainly, with no card, when the model's question fails a check", async () => {
    for (const bad of [{ ...good, stem: "A table has 10 slots and 9 keys." }, { ...good, quote: "not in the course" }]) {
      const r = await similarQuestion({ seed, question, graded: false }, gen(bad));
      expect(r.card).toBeNull();
      expect(r.text).toBe(SIMILAR_FAILED);
    }
  });

  it("the fake model's question passes every check (it is what the e2e answers)", async () => {
    const r = await similarQuestion({ seed, question, graded: false, marked: "B" }, fakeSimilar(question, { delayMs: 0 }));
    expect(r.card).not.toBeNull();
    expect(sharedValues(similarTurnText(r.card!), question)).toEqual([]);
  });
});

describe("the topic rule is scoped by where the tutor is open, decided on the server", () => {
  const base = { seed, question, graded: false, request: "reply" as const, message: "hi", history: [], marked: null };
  it("beside a question (and by default): this question, its lecture moment or slide, and the idea it tests", () => {
    const { prompt } = tutorPrompt(inputOf(base));
    expect(prompt).toContain("Stay on this question, its lecture moment or slide, and the idea it tests");
  });
  it("in the study session: the topics of the exam or assignment, as listed in the course material", () => {
    const { prompt } = tutorPrompt(inputOf({ ...base, scope: { kind: "study", name: "Fake Exam 2", topics: ["Heaps", "Hash <tables>"] } }));
    expect(prompt).toContain("Stay on the topics of Fake Exam 2, as listed in the course material (Heaps; Hash &lt;tables&gt;)");
    expect(prompt).not.toContain("Stay on this question");
  });
  it("the similar prompt follows the same scope", () => {
    expect(similarPromptOf({ seed, question, graded: false })).toContain(topicRule());
  });
});

describe("hint chips: every hint tries for one lecture chip and one slide chip, each only when grounded", () => {
  const call = { seed, question, graded: false, request: "hint" as const, history: [], marked: null };
  it("adds the explanation moment when the model quoted none; the question's own slide only once the student has answered", async () => {
    const r = await tutorReply(call, async () => ({ text: "Compare the two counts.", claims: [], confirms: false }));
    expect(r.grounded).toEqual([{ kind: "lecture", quote: LINE_1, start: 300 }]);
    const after = await tutorReply({ ...call, marked: "B" }, async () => ({ text: "Compare the two counts.", claims: [], confirms: false }));
    expect(after.grounded).toEqual([
      { kind: "lecture", quote: LINE_1, start: 300 },
      { kind: "slide", quote: SLIDE_QUOTE, deck: "7 - Hashing", page: 12, pageKind: "slide" },
    ]);
  });
  it("keeps the model's own lecture claim once the student has answered; before, one inside the explanation window gives way to the earlier introduction", async () => {
    const r = await tutorReply({ ...call, marked: "B" }, async () => ({ text: "Compare the two counts.", claims: [{ quote: LINE_2 }], confirms: false }));
    expect(r.grounded.filter((g) => g.kind === "lecture")).toEqual([{ kind: "lecture", quote: LINE_2, start: 310 }]);
    // LINE_2 (310 s) is inside the window (302 to 340 s); LINE_1 (300 s) is before it.
    const before = await tutorReply(call, async () => ({ text: "Compare the two counts.", claims: [{ quote: LINE_2 }], confirms: false }));
    expect(before.grounded).toEqual([{ kind: "lecture", quote: LINE_1, start: 300 }]);
  });
  it("adds nothing that isn't grounded: no clip, no slide quote, no chips", () => {
    const bare = { ...question, source: undefined, segments: [], match: { ...question.match, start: null, end: null } } as unknown as SeedQuestion;
    expect(explanationMoment(bare)).toBeNull();
    expect(hintChips([], bare)).toEqual([]);
  });
  it("leaves replies that aren't hints alone", async () => {
    const r = await tutorReply({ ...call, request: "reply", message: "I'm stuck" }, async () => ({ text: "What do you notice?", claims: [], confirms: false }));
    expect(r.grounded).toEqual([]);
  });
});

describe("the demo route's similar question", () => {
  let bundle: DemoBundle;
  beforeAll(async () => {
    bundle = (await readDemoBundle())!;
  });
  const KEY = "demo-key-for-tests-only";
  const q0 = () => bundle.sets[0].seed.questions[0];
  const post = (body: object) =>
    new Request("http://localhost/api/demo/tutor", { method: "POST", headers: { "content-type": "application/json", "x-vercel-forwarded-for": "203.0.113.9" }, body: JSON.stringify(body) });
  const events = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });
  function deps(model: DemoModel, over: Partial<DemoTutorDeps> = {}): DemoTutorDeps & { tags: string[] } {
    const tags: string[] = [];
    return { key: KEY, model: () => model, store: memoryStore(), bundle: async () => bundle, secure: false, log: (t) => tags.push(t), ...over, tags };
  }
  const fakeModel: DemoModel = async (p, s) => ({ reply: (await fakeSimilar(q0(), { delayMs: 0 })(p, s)) as never, inputTokens: 900, outputTokens: 200 });

  it("asks the demo model for up to DEMO_SIMILAR_MAX_TOKENS, and estimates the cost with the same cap", async () => {
    let asked: number | undefined;
    const model: DemoModel = async (p, s, o) => ((asked = o?.maxTokens), fakeModel(p, s));
    await handleDemoTutor(post({ questionId: q0().id, request: "similar" }), deps(model));
    expect(asked).toBe(DEMO_SIMILAR_MAX_TOKENS);
    expect(estimateMicro(3000, DEMO_SIMILAR_MAX_TOKENS)).toBeGreaterThan(estimateMicro(3000));
  });

  it("the demo route always uses the question scope", async () => {
    let sent = "";
    const model: DemoModel = async (p, s) => ((sent = p), fakeModel(p, s));
    await handleDemoTutor(post({ questionId: q0().id, request: "similar", scope: { kind: "study", name: "x", topics: [] } }), deps(model));
    expect(sent).toContain(topicRule());
    let turn = "";
    const tm: DemoModel = async (p) => ((turn = p), { reply: { text: "What is it asking?", claims: [], confirms: false }, inputTokens: 1, outputTokens: 1 });
    await handleDemoTutor(post({ questionId: q0().id, request: "reply", message: "help", scope: { kind: "study", name: "x", topics: [] } }), deps(tm));
    expect(turn).toContain(topicRule());
  });

  it("streams a checked question with its signature over the words the history carries", async () => {
    const res = await handleDemoTutor(post({ questionId: q0().id, request: "similar", marked: q0().choices.find((c) => c.label !== q0().answer)!.label, history: [] }), deps(fakeModel));
    const evs = await events(res);
    const done = evs.find((e) => e.t === "done")!;
    const card = done.similar as { stem: string; choices: { label: string; text: string }[] };
    expect(card.stem).toMatch(/^New values: /);
    expect(done.history).toBe(similarTurnText(card as never));
    expect(done.sig).toBe(demoSigner(KEY).replySig(q0().id, "reply", done.history as string));
  });

  it("goes through the same limits: no key, a rate limit and a dropped question each fall back", async () => {
    expect(await events(await handleDemoTutor(post({ questionId: q0().id, request: "similar" }), deps(fakeModel, { key: null })))).toEqual([{ t: "fallback", why: "no-key" }]);
    const d = deps(fakeModel);
    let last: Response | null = null;
    for (let i = 0; i < 7; i++) last = await handleDemoTutor(post({ questionId: q0().id, request: "similar" }), d);
    expect(last!.status).toBe(429);
    expect(d.tags).toContain("limit-rate");
    const reuse: DemoModel = async () => ({ reply: { ...good, quote: "nothing in the course says this" } as never, inputTokens: 900, outputTokens: 200 });
    const dropped = deps(reuse);
    expect(await events(await handleDemoTutor(post({ questionId: q0().id, request: "similar" }), dropped))).toEqual([{ t: "fallback", why: "similar" }]);
    expect(dropped.tags).toEqual(["similar-dropped"]);
  });

  it("precomputes saved similar questions with the fake (--fake), and the saved file passes the live checks", async () => {
    const byStem = new Map(bundle.sets.flatMap((s) => s.seed.questions.map((q) => [q.stem, q] as const)));
    const find = (p: string) => [...byStem.entries()].find(([stem]) => p.includes(stem))![1];
    const { file, report } = await precomputeTutor(bundle, (p, s) => fakeTutor(find(p), { delayMs: 0 })(p, s), "fake", (p, s) => fakeSimilar(find(p), { delayMs: 0 })(p, s));
    // The fake can't always write one (a question whose choices are all numbers); nearly every question gets one.
    expect(report.similar).toBeGreaterThanOrEqual(report.questions - 2);
    expect(validateSaved(file, bundle)).toEqual([]);
    const entry = file.questions[q0().id];
    expect(pickSavedSimilar(entry, 0)).toEqual(entry.similar![0]);
    expect(pickSavedSimilar(undefined, 0)).toBeNull();
    expect(NO_SAVED_SIMILAR).not.toMatch(/course says/i);
    // A saved question that reuses the original's numbers or misquotes is caught.
    const bad = JSON.parse(JSON.stringify(file));
    bad.questions[q0().id].similar[0].source.quote = "a sentence that is nowhere in the course";
    expect(validateSaved(bad, bundle).join("\n")).toContain(`${q0().id}.similar[0]: ungrounded`);
    // Coverage: a file without them says so (a warning, not a failure).
    const raw = { sets: bundle.sets.map((s) => ({ questions: s.seed.questions.map((q) => ({ id: q.id })) })) };
    expect(similarGaps(raw, file).length).toBe(bundle.sets.flatMap((s) => s.seed.questions).filter((q) => !file.questions[q.id].similar?.length).length);
    expect(similarWarning(raw, { questions: {} })).toContain("no saved similar question");
  });
});
