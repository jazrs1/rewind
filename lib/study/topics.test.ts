// The study session's rail (lib/study/topics.ts) on the committed demo bundle's tape: the Course tape's own module
// colours, priority order (stressed × missed), graded flags from the server's list, and the exam line's days.
import { beforeAll, describe, expect, it } from "vitest";
import { shellOf } from "../../components/course/shared";
import { attemptTopic } from "../attempts/examples";
import { mergeAttempts } from "../course/attempts";
import { readDemoBundle, type DemoBundle } from "../demo/bundle";
import { buildDemoTape } from "../demo/tape";
import { demoStudyConfig } from "./config";
import { daysText, shellOfTape, studyTopics } from "./topics";

let bundle: DemoBundle;
beforeAll(async () => {
  bundle = (await readDemoBundle())!;
});
const ids = () => bundle.sets.flatMap((s) => s.seed.questions.map((q) => q.id));

describe("studyTopics", () => {
  it("uses the Course tape's module colours, so a topic is the same colour everywhere", () => {
    const { tape } = buildDemoTape(bundle);
    const tapeShell = shellOf(tape);
    const byId = new Map(tape.stops.map((s) => [s.id, s]));
    for (const t of studyTopics(tape, ids(), [])) expect(t.shell).toBe(tapeShell(byId.get(t.id)!));
    expect(shellOfTape(tape)(tape.stops[0])).toBe(tapeShell(tape.stops[0]));
  });

  it("orders by priority: stressed × missed", () => {
    const { tape } = buildDemoTape(bundle);
    // Miss every question of the last stop: it becomes the top topic.
    const last = tape.stops.at(-1)!;
    const qs = bundle.sets.flatMap((s) => s.seed.questions).filter((q) => last.practiceIds.includes(q.id));
    // The topic the app stores with an attempt (lib/attempts/client.ts): the question's demo topic.
    const attempts = qs.map((q) => ({ questionId: q.id, topic: attemptTopic(q), stem: q.stem, choice: q.choices.find((c) => c.label !== q.answer)!.label, correct: false, answeredAt: "2026-10-23T12:00:00Z", example: false }));
    const topics = studyTopics(mergeAttempts(tape, attempts), ids(), []);
    expect(topics[0].id).toBe(last.id);
    expect(topics[0].wrong).toBe(qs.length);
    for (let i = 1; i < topics.length; i++) if (!topics[i].ahead && !topics[i - 1].ahead) expect(topics[i - 1].priority).toBeGreaterThanOrEqual(topics[i].priority);
  });

  it("keeps only topics with questions the session has, and marks graded topics from the server's list", () => {
    const { tape } = buildDemoTape(bundle);
    const first = tape.stops[0];
    const topics = studyTopics(tape, first.practiceIds, [first.practiceIds[0]]);
    expect(topics.map((t) => t.id)).toEqual([first.id]);
    expect(topics[0].graded).toBe(true);
    expect(topics[0].anchorId).toBe(first.practiceIds[0]);
  });

  it("the demo session: never graded, the demo tutor route, its exam line says it has no date", () => {
    const c = demoStudyConfig(bundle, buildDemoTape(bundle));
    expect(c.tutor.endpoint).toBe("/api/demo/tutor");
    expect(c.tutor.gradedIds).toEqual([]);
    expect(studyTopics(c.tape, c.seed.questions.map((q) => q.id), c.tutor.gradedIds).every((t) => !t.graded)).toBe(true);
    expect(c.examLine).toMatch(/no exam date/);
  });
});

describe("daysText", () => {
  it("says when the exam is", () => {
    expect(daysText(6)).toBe("in 6 days");
    expect(daysText(1)).toBe("tomorrow");
    expect(daysText(0)).toBe("today");
    expect(daysText(null)).toBeNull();
  });
});

describe("turnBelongs: a topic's turn shows only that topic's clips, chips and slides", () => {
  const topics = [
    { id: "sorting", questionIds: ["s1", "s2"] },
    { id: "graphs", questionIds: ["g1"] },
  ];
  it("keeps a turn whose question is its topic's, drops one that isn't", async () => {
    const { turnBelongs } = await import("../../components/study/StudySession");
    expect(turnBelongs({ topic: "graphs", qid: "g1" }, topics)).toBe(true);
    expect(turnBelongs({ topic: "graphs", qid: "s1" }, topics)).toBe(false);
    expect(turnBelongs({ topic: "graphs", qid: "g1", moment: { questionId: "s2", start: 1, quote: "x" } }, topics)).toBe(false);
    expect(turnBelongs({ topic: "sorting", quiz: "s2", qid: "s2" }, topics)).toBe(true);
    // Carried over from the tutor panel (no topic): kept as it was.
    expect(turnBelongs({ qid: "s1" }, topics)).toBe(true);
  });
});
