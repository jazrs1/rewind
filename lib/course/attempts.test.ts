// Merging browser-kept practice attempts into a server-built tape, on an invented course.
import { describe, expect, it } from "vitest";
import type { ImportItem } from "../import/types.ts";
import type { TranscriptSegment } from "../schema.ts";
import { hasExampleEvidence, mergeAttempts, stopForAttempt, type TapeAttempt } from "./attempts.ts";
import { buildCourseTape, WEIGHTS } from "./build.ts";
import type { CourseTapeInputs, LectureInput, ModuleInput } from "./types.ts";

const LECTURER = "Prof Example";

function mod(position: number, topic: string): ModuleInput {
  return { id: `m${position}`, name: `Module ${position}`, position, itemTitles: [`Module ${position}: ${topic}`], from: "canvas" };
}

function talk(fromSec: number, minutes: number, word: string): TranscriptSegment[] {
  return Array.from({ length: minutes * 6 }, (_, i) => ({ start: fromSec + i * 10, end: fromSec + i * 10 + 10, speaker: LECTURER, text: `Here the ${word} turns, and every ${word} matters.` }));
}

function lecture(id: string, date: string, segments: TranscriptSegment[]): LectureInput {
  return { id, title: "Lecture", recordedAt: `${date}T17:00:00Z`, recordingUrl: `https://example.test/${id}`, durationSec: 3000, lecturer: LECTURER, segments };
}

function deck(id: number, name: string): ImportItem {
  return { fileId: id, name, contentType: "application/pdf", size: 100, url: `/courses/1/files/${id}`, role: "unknown", roleReason: null, foundIn: [{ kind: "files" }], mergedFileIds: [] };
}

function inputs(over: Partial<CourseTapeInputs> = {}): CourseTapeInputs {
  return {
    course: { code: "XYZ1000", name: "Invented Course" },
    now: "2026-09-20T16:00:00Z",
    modules: [mod(2, "Widgets"), mod(3, "Gizmos"), mod(4, "Sprockets")],
    items: [deck(10, "2 - Widgets.pdf"), deck(11, "3 - Gizmos.pdf")],
    lectures: [lecture("l1", "2026-09-01", talk(0, 8, "widget")), lecture("l2", "2026-09-08", talk(0, 12, "gizmo"))],
    radar: [],
    practice: [],
    grades: [],
    announcements: [],
    exams: [],
    nextExam: null,
    ...over,
  };
}

const attempt = (over: Partial<TapeAttempt> = {}): TapeAttempt => ({
  questionId: "q1",
  topic: "2 - Widgets",
  stem: "Which widget turns first?",
  correct: false,
  answeredAt: "2026-09-15T15:00:00Z",
  example: false,
  ...over,
});

describe("mergeAttempts", () => {
  it("no attempts: the tape is unchanged", () => {
    const tape = buildCourseTape(inputs());
    expect(mergeAttempts(tape, [])).toBe(tape);
  });

  it("places an attempt by its slide deck, else by the topic it names", () => {
    const tape = buildCourseTape(inputs());
    expect(stopForAttempt(tape.stops, { topic: "2 - Widgets", stem: null })).toBe("widgets");
    expect(stopForAttempt(tape.stops, { topic: "3 - gizmos", stem: null })).toBe("gizmos");
    expect(stopForAttempt(tape.stops, { topic: "Sprockets, part 2", stem: null })).toBe("sprockets");
    expect(stopForAttempt(tape.stops, { topic: "Unrelated", stem: null })).toBeNull();
  });

  it("matches what buildCourseTape gives for the same answers (missed scores, heat, route)", () => {
    const answers = [attempt(), attempt({ correct: true }), attempt({ questionId: "q2", topic: "3 - Gizmos", stem: "What does a gizmo hold?" })];
    const merged = mergeAttempts(buildCourseTape(inputs()), answers);
    const direct = buildCourseTape(
      inputs({
        practice: answers.map((a, i) => ({
          id: `p${i}`,
          text: a.stem!,
          lectureId: null,
          clip: { start: 0, end: 30, slide: { deck: a.topic, page: 1 } },
          attempts: [{ correct: a.correct, answeredAt: a.answeredAt }],
        })),
      }),
    );
    for (const s of merged.stops) {
      const d = direct.stops.find((x) => x.id === s.id)!;
      expect(s.missed.score).toBe(d.missed.score);
      expect(s.missed.heat).toBe(d.missed.heat);
      expect(s.missed.evidence.map((e) => [e.kind, e.points, e.quote, e.at])).toEqual(d.missed.evidence.map((e) => [e.kind, e.points, e.quote, e.at]));
    }
    expect(merged.route.steps.map((s) => [s.stopId, s.product, s.reason])).toEqual(direct.route.steps.map((s) => [s.stopId, s.product, s.reason]));
  });

  it("a wrong answer adds WEIGHTS.practiceWrong to missed, a right one 0, and every score is its evidence sum", () => {
    const tape = mergeAttempts(buildCourseTape(inputs()), [attempt(), attempt({ correct: true })]);
    const widgets = tape.stops.find((s) => s.id === "widgets")!;
    expect(widgets.missed.score).toBe(WEIGHTS.practiceWrong + WEIGHTS.practiceRight);
    expect(widgets.missed.evidence.map((e) => e.detail)).toEqual(["You missed it", "You got it right"]);
    expect(widgets.missed.evidence[0]).toMatchObject({ kind: "practice", source: "Your practice", quote: "Which widget turns first?", at: "2026-09-15" });
    expect(widgets.missed.evidence[0].example).toBeUndefined();
    for (const s of tape.stops) expect(s.missed.score).toBe(Math.round(s.missed.evidence.reduce((t, e) => t + e.points, 0) * 100) / 100);
    expect(widgets.missed.heat).toBe(1);
  });

  it("misses move a stressed stop to the top of the route", () => {
    const base = buildCourseTape(inputs());
    // Gizmos has more lecture minutes, so it leads on stress alone.
    expect(base.route.steps[0].stopId).toBe("gizmos");
    expect(base.route.steps.every((s) => s.reason === "stressed-only")).toBe(true);
    const tape = mergeAttempts(base, [attempt(), attempt({ questionId: "q3" })]);
    expect(tape.route.steps[0]).toMatchObject({ stopId: "widgets", reason: "stressed-and-missed", rank: 1 });
    expect(tape.totals.questions).toBe(tape.route.steps.reduce((s, st) => s + st.practiceIds.length, 0));
  });

  it("keeps the next-exam pool when its coverage is known", () => {
    const base = buildCourseTape(inputs({ nextExam: { id: "e1", name: "Quiz 3 - Gizmos", at: "2026-09-25T16:00:00Z", coverage: { quote: "Quiz 3 - Gizmos", source: "Canvas assignment title" } } }));
    expect(base.route.basis).toBe("next-exam");
    const tape = mergeAttempts(base, [attempt(), attempt()]);
    expect(tape.route.steps.map((s) => s.stopId)).toEqual(["gizmos"]);
    expect(tape.route.label).toBe(base.route.label);
  });

  it("labels example attempts, and an unplaced attempt is shown, never dropped", () => {
    const tape = mergeAttempts(buildCourseTape(inputs()), [attempt({ example: true }), attempt({ topic: "Unrelated", stem: null })]);
    const widgets = tape.stops.find((s) => s.id === "widgets")!;
    expect(widgets.missed.evidence[0]).toMatchObject({ example: true, source: "Example practice history" });
    expect(hasExampleEvidence(tape)).toBe(true);
    expect(tape.unplaced).toHaveLength(1);
    expect(hasExampleEvidence(mergeAttempts(buildCourseTape(inputs()), [attempt()]))).toBe(false);
  });

  it("doesn't change the server's tape object", () => {
    const base = buildCourseTape(inputs());
    const before = JSON.stringify(base);
    mergeAttempts(base, [attempt(), attempt({ topic: "Unrelated" })]);
    expect(JSON.stringify(base)).toBe(before);
  });
});
