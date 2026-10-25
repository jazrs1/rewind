// Course tape builder on an invented course (no real course text).
import { describe, expect, it } from "vitest";
import type { ImportItem } from "../import/types.ts";
import type { TranscriptSegment } from "../schema.ts";
import { buildCourseTape, easternDate, modulesFromCanvas, modulesFromLectures, STRESS, stressHeat, weekStart, WEIGHTS } from "./build.ts";
import { glowLevel } from "./geometry.ts";
import { pipelinePractice } from "./local.ts";
import { topicIndex, topicsIn } from "./topics.ts";
import type { CourseTape, CourseTapeInputs, LectureInput, ModuleInput, Score } from "./types.ts";

const LECTURER = "Prof Example";

function mod(position: number, topic: string, extra: string[] = []): ModuleInput {
  return { id: `m${position}`, name: `Module ${position}`, position, itemTitles: [`Module ${position}: ${topic}`, ...extra], from: "canvas" };
}

/** `minutes` of the lecturer talking about `word`, one line every 10 s, from `fromSec`. */
function talk(fromSec: number, minutes: number, word: string): TranscriptSegment[] {
  return Array.from({ length: minutes * 6 }, (_, i) => ({
    start: fromSec + i * 10,
    end: fromSec + i * 10 + 10,
    speaker: LECTURER,
    text: `Here the ${word} turns, and every ${word} matters.`,
  }));
}

function lecture(id: string, date: string, segments: TranscriptSegment[]): LectureInput {
  return { id, title: "Lecture", recordedAt: `${date}T17:00:00Z`, recordingUrl: `https://example.test/${id}`, durationSec: 3000, lecturer: LECTURER, segments };
}

function deck(id: number, name: string, role: ImportItem["role"] = "unknown"): ImportItem {
  return { fileId: id, name, contentType: "application/pdf", size: 100, url: `/courses/1/files/${id}`, role, roleReason: null, foundIn: [{ kind: "files" }], mergedFileIds: [] };
}

function base(over: Partial<CourseTapeInputs> = {}): CourseTapeInputs {
  return {
    course: { code: "XYZ1000", name: "Invented Course" },
    now: "2026-09-10T16:00:00Z",
    modules: [mod(1, "Course Orientation"), mod(2, "Widgets"), mod(3, "Gizmos"), mod(4, "Sprockets")],
    items: [],
    lectures: [],
    radar: [],
    practice: [],
    grades: [],
    announcements: [],
    exams: [],
    nextExam: null,
    ...over,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (s: Score) => round2(s.evidence.reduce((t, e) => t + e.points, 0));
const stop = (t: CourseTape, id: string) => t.stops.find((s) => s.id === id)!;

describe("stops", () => {
  it("one stop per module topic; orientation modules aren't stops", () => {
    const t = buildCourseTape(base());
    expect(t.stops.map((s) => s.topic)).toEqual(["Widgets", "Gizmos", "Sprockets"]);
    expect(t.notes.some((n) => n.includes("Orientation"))).toBe(true);
  });

  it("orders stops by first-taught date; undated ones keep their course-order place", () => {
    const t = buildCourseTape(
      base({
        lectures: [lecture("l1", "2026-09-01", talk(0, 6, "sprocket")), lecture("l2", "2026-09-08", talk(0, 6, "widget"))],
      }),
    );
    expect(t.stops.map((s) => s.id)).toEqual(["sprockets", "widgets", "gizmos"]);
    expect(t.stops.map((s) => s.firstTaughtAt)).toEqual(["2026-09-01", "2026-09-08", null]);
    expect(t.stops.map((s) => s.order)).toEqual([0, 1, 2]);
    // Evenly spaced (no final exam date), increasing along the tape, never on a reel.
    expect(t.positionBasis).toBe("order");
    expect(t.stops.map((s) => s.position)).toEqual([0.25, 0.5, 0.75]);
  });

  it("breaks same-day ties by course order (not by when in the lecture)", () => {
    const t = buildCourseTape(
      base({
        modules: [mod(2, "Widgets"), mod(4, "Sprockets")],
        lectures: [lecture("l1", "2026-09-01", [...talk(0, 6, "sprocket"), ...talk(600, 6, "widget")])],
      }),
    );
    expect(t.stops.map((s) => s.id)).toEqual(["widgets", "sprockets"]);
    expect(t.stops.map((s) => s.state)).toEqual(["past", "current"]);
  });

  it("dates a topic from a week announcement's range when no lecture has it", () => {
    const t = buildCourseTape(
      base({ announcements: [{ id: "a1", title: "Week 2: Gizmos (Sep 7-13)", postedAt: "2026-09-06T22:00:00Z", lines: [] }] }),
    );
    expect(stop(t, "gizmos").firstTaughtAt).toBe("2026-09-07");
    expect(stop(t, "gizmos").firstTaughtFrom).toMatchObject({ kind: "announcement", quote: "Week 2: Gizmos (Sep 7-13)" });
  });

  it("past, current and future around now; the tape head sits on the current stop", () => {
    const t = buildCourseTape(
      base({
        now: "2026-09-10T16:00:00Z",
        lectures: [lecture("l1", "2026-09-01", talk(0, 6, "widget")), lecture("l2", "2026-09-08", talk(0, 6, "gizmo"))],
      }),
    );
    expect(t.stops.map((s) => [s.id, s.state])).toEqual([
      ["widgets", "past"],
      ["gizmos", "current"],
      ["sprockets", "future"],
    ]);
    expect(t.here).toEqual({ stopId: "gizmos", position: stop(t, "gizmos").position });
  });

  it("a lecture after now is still ahead of the tape head", () => {
    const t = buildCourseTape(
      base({ now: "2026-09-05T12:00:00Z", lectures: [lecture("l1", "2026-09-01", talk(0, 6, "widget")), lecture("l2", "2026-09-08", talk(0, 6, "gizmo"))] }),
    );
    expect(stop(t, "widgets").state).toBe("current");
    expect(stop(t, "gizmos").state).toBe("future");
  });

  it("with no dates at all, state is unknown rather than guessed", () => {
    const t = buildCourseTape(base());
    expect(t.stops.every((s) => s.state === "unknown")).toBe(true);
    expect(t.here).toEqual({ stopId: null, position: null });
  });

  it("uses dates for positions when the first lecture and final exam are known", () => {
    const t = buildCourseTape(
      base({
        term: { firstLectureAt: "2026-09-01", finalExamAt: "2026-09-21" },
        lectures: [lecture("l1", "2026-09-06", talk(0, 6, "widget")), lecture("l2", "2026-09-16", talk(0, 6, "sprocket"))],
      }),
    );
    expect(t.positionBasis).toBe("dates");
    expect(t.stops.map((s) => [s.id, s.position])).toEqual([
      ["widgets", 0.25],
      ["gizmos", 0.5],
      ["sprockets", 0.75],
    ]);
    expect(t.here.position).toBe(round2(9 / 20));
  });

  it("a slide deck that names no module becomes its own stop after the deck before it", () => {
    const t = buildCourseTape(base({ items: [deck(1, "1 - Widgets.pdf"), deck(2, "1b - Widget Assembly.pdf"), deck(3, "2 - Gizmos.pdf"), deck(4, "Widgets_REVIEW.pdf", "review")] }));
    expect(t.stops.map((s) => s.topic)).toEqual(["Widgets", "Widget Assembly", "Gizmos", "Sprockets"]);
    expect(stop(t, "widget-assembly").topicFrom).toBe("slides");
    expect(stop(t, "widgets").slides.map((s) => s.label)).toEqual(["1 - Widgets.pdf"]);
  });
});

describe("scores are the evidence they're built from", () => {
  const scoreInputs = base({
      lectures: [lecture("l1", "2026-09-01", [...talk(0, 6, "widget"), { start: 400, end: 410, speaker: "Student", text: "Is the widget on the test?" }])],
      radar: [{ lectureId: "l1", start: 120, kinds: ["exam"], phrases: ["on the exam"], text: "Here the widget turns, and every widget matters." }],
      items: [deck(9, "Widgets_REVIEW.pdf", "review"), deck(10, "Widgets_REVIEW-1.pdf", "review")],
      announcements: [{ id: "a1", title: "Reminders", postedAt: "2026-09-02T12:00:00Z", lines: ["Bring notes on widgets.", "Office hours moved."] }],
      practice: [
        { id: "p1", text: "Which widget turns first?", lectureId: null, clip: null, attempts: [{ correct: false, answeredAt: "2026-09-03T12:00:00Z" }, { correct: true, answeredAt: "2026-09-04T12:00:00Z" }] },
        { id: "p2", text: "How many gizmos?", lectureId: null, clip: null, attempts: null },
      ],
      grades: [
        { id: "g1", name: "Quiz 1 - Widgets", score: 5, possible: 10, gradedAt: "2026-09-05T12:00:00Z" },
        { id: "g2", name: "Participation quiz: Widgets", score: 0, possible: 1, gradedAt: null },
      ],
    });
  const t = buildCourseTape(scoreInputs);

  it("every score equals the sum of its evidence points", () => {
    for (const s of t.stops) {
      expect(s.stressed.score).toBe(sum(s.stressed));
      expect(s.missed.score).toBe(sum(s.missed));
    }
  });

  it("stressed = radar + minutes + reviews + announcements, each with a quote and source", () => {
    const w = stop(t, "widgets");
    expect(w.stressed.evidence.map((e) => [e.kind, e.points])).toEqual([
      ["radar", WEIGHTS.radar.exam],
      ["review", WEIGHTS.review],
      ["minutes", round2(6 * WEIGHTS.minutePoints)],
      ["announcement", WEIGHTS.announcement],
    ]);
    expect(w.stressed.score).toBe(round2(3 + 2 + 0.6 + 1));
    expect(w.stressed.evidence.every((e) => e.quote && e.source)).toBe(true);
    // Only the lecturer's lines count, and the quote is his line word for word.
    expect(w.stressed.evidence.find((e) => e.kind === "minutes")!.quote).toBe("Here the widget turns, and every widget matters.");
    expect(w.lectureMinutes).toBe(6);
  });

  it("missed = saved practice attempts only by default: Canvas grades are ignored; unknown attempts add nothing", () => {
    const w = stop(t, "widgets");
    expect(w.missed.evidence.map((e) => [e.kind, e.points])).toEqual([
      ["practice", WEIGHTS.practiceWrong],
      ["practice", WEIGHTS.practiceRight],
    ]);
    expect(w.missed.score).toBe(round2(WEIGHTS.practiceWrong + WEIGHTS.practiceRight));
    expect(t.stops.flatMap((s) => s.missed.evidence).some((e) => e.kind === "grade")).toBe(false);
    const g = stop(t, "gizmos");
    expect(g.practiceIds).toEqual(["p2"]);
    expect(g.missed).toEqual({ score: 0, heat: 0, evidence: [] });
  });

  it("with includeGrades on (waiting on John), grades add to missed; participation adds nothing", () => {
    const g = buildCourseTape({ ...scoreInputs, includeGrades: true });
    const w = stop(g, "widgets");
    expect(w.missed.evidence.map((e) => [e.kind, e.points])).toEqual([
      ["grade", 1.5],
      ["practice", WEIGHTS.practiceWrong],
      ["practice", WEIGHTS.practiceRight],
    ]);
    expect(w.missed.score).toBe(2.5);
  });

  it("a topic with no evidence scores 0, not a guess", () => {
    const s = stop(t, "sprockets");
    expect(s.stressed).toEqual({ score: 0, heat: 0, evidence: [] });
    expect(s.missed).toEqual({ score: 0, heat: 0, evidence: [] });
    expect(s.clips).toEqual([]);
  });

  it("heat is the share of the highest score on the tape", () => {
    expect(stop(t, "widgets").stressed.heat).toBe(1);
    expect(stop(t, "widgets").missed.heat).toBe(1);
  });

  it("clips start on real lecturer lines and stay short", () => {
    const clips = stop(t, "widgets").clips;
    expect(clips[0].from).toBe("radar");
    expect(clips[0].start).toBe(120);
    for (const c of clips) expect(c.end - c.start).toBeLessThanOrEqual(75);
  });
});

describe("route back", () => {
  // Five taught topics; Gizmos has the biggest product but isn't on the quiz.
  const modules = [mod(1, "Widgets"), mod(2, "Gizmos"), mod(3, "Sprockets"), mod(4, "Flanges"), mod(5, "Cogs"), mod(6, "Ratchets")];
  const lectures = [
    lecture("l1", "2026-09-01", talk(0, 10, "widget")),
    lecture("l2", "2026-09-02", talk(0, 30, "gizmo")),
    lecture("l3", "2026-09-03", talk(0, 20, "sprocket")),
    lecture("l4", "2026-09-04", talk(0, 6, "flange")),
    lecture("l5", "2026-09-05", talk(0, 40, "cog")),
  ];
  const grade = (id: string, name: string, score: number) => ({ id, name, score, possible: 10, gradedAt: null });
  const grades = [grade("g1", "Quiz - Widgets", 0), grade("g2", "Quiz - Gizmos", 0), grade("g3", "Quiz - Sprockets", 6), grade("g4", "Quiz - Flanges", 0), grade("g5", "Quiz - Cogs", 10)];
  // These cases rank by grades, so they switch the grade path on (off by default).
  const inputs = base({ now: "2026-09-20T12:00:00Z", modules, lectures, grades, includeGrades: true });

  it("is the top 3 by stressed × missed among taught topics on the next exam", () => {
    const t = buildCourseTape({
      ...inputs,
      nextExam: { id: "q2", name: "Quiz 2", at: "2026-09-25T12:00:00Z", coverage: { quote: "Quiz 2 - Widgets, Sprockets, Flanges, Cogs and Ratchets", source: "title" } },
    });
    expect(t.route.basis).toBe("next-exam");
    expect(stop(t, "gizmos").onNextExam).toBe(false);
    expect(stop(t, "ratchets").onNextExam).toBe(true);
    const onExam = t.stops.filter((s) => s.onNextExam && s.state !== "future");
    const expected = [...onExam]
      .filter((s) => s.stressed.score * s.missed.score > 0)
      .sort((a, b) => b.stressed.score * b.missed.score - a.stressed.score * a.missed.score)
      .slice(0, 3)
      .map((s) => s.id);
    expect(expected).toEqual(["widgets", "sprockets", "flanges"]);
    expect(t.route.steps.map((s) => s.stopId)).toEqual(expected);
    expect(t.route.steps.map((s) => s.rank)).toEqual([1, 2, 3]);
    for (const step of t.route.steps) {
      const s = stop(t, step.stopId);
      expect(step.product).toBe(round2(s.stressed.score * s.missed.score));
      expect(step.reason).toBe("stressed-and-missed");
      expect(step.play.kind).toBe("clip");
    }
    expect(t.route.label).toBe("for Quiz 2");
    expect(t.totals.listenSec).toBe(t.route.steps.reduce((n, s) => n + (s.play.kind === "clip" ? s.play.clip.end - s.play.clip.start : 0), 0));
  });

  it("fills with stressed-only stops when fewer than 3 have both", () => {
    const t = buildCourseTape({ ...inputs, nextExam: { id: "q3", name: "Quiz 3", at: null, coverage: { quote: "Quiz 3 - Cogs and Widgets", source: "title" } } });
    expect(t.route.steps.map((s) => [s.stopId, s.reason])).toEqual([
      ["widgets", "stressed-and-missed"],
      ["cogs", "stressed-only"],
    ]);
  });

  it("unknown coverage: onNextExam is null and the route ranks every taught topic, labeled so", () => {
    const t = buildCourseTape({ ...inputs, nextExam: { id: "e2", name: "Exam 2", at: "2026-10-01T12:00:00Z", coverage: null } });
    expect(t.stops.every((s) => s.onNextExam === null)).toBe(true);
    expect(t.route.basis).toBe("overall");
    expect(t.route.label).toContain("Exam 2 coverage unknown");
    expect(t.route.steps.map((s) => s.stopId)).toEqual(["gizmos", "widgets", "sprockets"]);
  });

  it("never routes back to a topic that hasn't been taught", () => {
    const t = buildCourseTape({ ...inputs, now: "2026-09-02T23:00:00Z", nextExam: null });
    expect(t.route.steps.map((s) => s.stopId)).toEqual(["gizmos", "widgets"]);
  });

  it("ties are broken by stressed, then missed, then tape order", () => {
    const tie = base({
      now: "2026-09-20T12:00:00Z",
      modules: [mod(1, "Widgets"), mod(2, "Gizmos")],
      lectures: [lecture("l1", "2026-09-01", talk(0, 10, "widget")), lecture("l2", "2026-09-02", talk(0, 10, "gizmo"))],
      grades: [grade("g1", "Quiz - Widgets", 0), grade("g2", "Quiz - Gizmos", 0)],
      includeGrades: true,
    });
    expect(buildCourseTape(tie).route.steps.map((s) => s.stopId)).toEqual(["widgets", "gizmos"]);
  });
});

describe("pipeline questions", () => {
  it("a generated question's real clip (with its setup line) is the stop's first clip and what the route plays", () => {
    const l = lecture("l1", "2026-09-01", talk(0, 6, "widget"));
    const q = pipelinePractice(
      {
        id: "gen-1",
        examId: null,
        topic: "Widgets",
        stem: "Which widget turns first?",
        choices: [],
        answer: "A",
        explanation: "",
        quote: "every widget matters",
        quoteSource: { kind: "slide", itemId: "f1", fileId: 1, page: 3, deck: "2 - Widgets" },
        styleItemId: null,
        check: { agreed: true, attempts: 1, reason: null },
        retrieval: {
          clip: { recordingUrl: l.recordingUrl, start: 120, end: 160, exampleStart: 100, setup: "He's turning the first widget.", sourceLines: [], transcriptId: "l1" },
          slide: null,
          fallback: null,
        },
        prompts: {},
      },
      [l],
    );
    expect(q).toMatchObject({ id: "gen-1", topic: "Widgets", lectureId: "l1", clip: { start: 120, end: 160, setup: "He's turning the first widget.", exampleStart: 100, slide: { deck: "2 - Widgets", page: 3 } } });
    const t = buildCourseTape(base({ lectures: [l], practice: [{ ...q, attempts: [{ correct: false, answeredAt: "2026-09-05T12:00:00Z" }] }] }));
    const w = stop(t, "widgets");
    expect(w.practiceIds).toContain("gen-1");
    expect(w.clips[0]).toMatchObject({ from: "practice-match", start: 120, end: 160, setup: "He's turning the first widget.", exampleStart: 100 });
    expect(t.route.steps[0]).toMatchObject({ stopId: "widgets", play: { kind: "clip", clip: { start: 120, end: 160 } } });
  });

  it("a question whose clip names no lecture we have brings no clip, never a guessed one", () => {
    const q = pipelinePractice(
      {
        id: "gen-2",
        examId: null,
        topic: "Gizmos",
        stem: "What is a gizmo?",
        choices: [],
        answer: "A",
        explanation: "",
        quote: "",
        quoteSource: { kind: "syllabus", itemId: "s" },
        styleItemId: null,
        check: { agreed: true, attempts: 1, reason: null },
        retrieval: { clip: { recordingUrl: "https://example.test/other", start: 5, end: 30, exampleStart: null, setup: null, sourceLines: [], transcriptId: "unknown-talk" }, slide: null, fallback: null },
        prompts: {},
      },
      [lecture("l1", "2026-09-01", [])],
    );
    expect(q).toMatchObject({ lectureId: null, clip: null });
  });
});

describe("a course without recordings", () => {
  it("still gets stops from modules and slides, and the route shows slides instead of clips", () => {
    const t = buildCourseTape(
      base({
        items: [deck(1, "1 - Widgets.pdf"), deck(2, "3 - Sprockets.pdf")],
        announcements: [{ id: "a1", title: "Week 1: Widgets (Sep 1-7)", postedAt: "2026-08-31T12:00:00Z", lines: [] }],
        grades: [{ id: "g1", name: "Quiz 1 - Widgets", score: 6, possible: 10, gradedAt: null }],
      }),
    );
    expect(t.stops.map((s) => s.topic)).toEqual(["Widgets", "Gizmos", "Sprockets"]);
    expect(t.stops.every((s) => s.clips.length === 0)).toBe(true);
    expect(t.route.steps).toHaveLength(1);
    expect(t.route.steps[0].play).toEqual({ kind: "fallback", fallback: { kind: "slides", label: "1 - Widgets.pdf", href: "/courses/1/files/1" } });
    expect(t.notes.some((n) => n.startsWith("No lecture recordings"))).toBe(true);
    expect(t.totals.listenSec).toBe(0);
  });
});

describe("helpers", () => {
  it("modulesFromCanvas keeps Canvas order and item titles", () => {
    const m = modulesFromCanvas([
      { id: 2, name: "Module 2", position: 2, items: [{ id: 1, title: "Module 2: Gizmos", type: "Page" }] },
      { id: 1, name: "Module 1", position: 1, items: [] },
    ]);
    expect(m.map((x) => [x.id, x.position, x.itemTitles])).toEqual([
      ["1", 1, []],
      ["2", 2, ["Module 2: Gizmos"]],
    ]);
  });

  it("modulesFromLectures reads the module a lecture opens with", () => {
    const m = modulesFromLectures([
      lecture("l1", "2026-09-01", [{ start: 5, end: 9, speaker: LECTURER, text: "Hello, this is lecture two of Module 4, all about Sprockets." }]),
      lecture("l2", "2026-09-02", [{ start: 5, end: 9, speaker: "Student", text: "Module 9, which is Cogs." }]),
    ]);
    expect(m).toEqual([{ id: "lecture-module-4", name: "Module 4: Sprockets", position: 4, itemTitles: [], from: "lecture" }]);
  });

  it("topicsIn picks the most specific topic", () => {
    const idx = topicIndex([
      { key: "gizmos", topic: "Gizmos" },
      { key: "advanced-gizmos", topic: "Advanced Gizmos" },
      { key: "widgets", topic: "Widgets and Flanges" },
    ]);
    expect(topicsIn("Quiz on Advanced Gizmos", idx)).toEqual(["advanced-gizmos"]);
    expect(topicsIn("Gizmo drill", idx)).toEqual(["gizmos"]);
    expect(topicsIn("Flanges", idx)).toEqual(["widgets"]);
    expect(topicsIn("Office hours", idx)).toEqual([]);
  });

  it("weekStart and easternDate", () => {
    expect(weekStart("Week - 9 : Gizmos (Oct 12-18)", "2026-10-11T22:00:00Z")).toBe("2026-10-12");
    expect(weekStart("Week 1 (Jan 3-9)", "2026-12-30T12:00:00Z")).toBe("2027-01-03");
    expect(weekStart("No range here", "2026-10-11T22:00:00Z")).toBeNull();
    expect(easternDate("2026-10-23T02:00:00Z")).toBe("2026-10-22");
  });
});

// Brief E (docs/briefs/tape-glow.md): minutes from the slide timeline, an absolute glow with a floor, clip-only lectures.
describe("stressed: slide-timeline minutes and an absolute glow", () => {
  const span = (startSec: number, endSec: number, deck: string, page = 1) => ({ startSec, endSec, deck, page });
  const decks = [deck(11, "2 - Widgets.pdf", "lecture"), deck(12, "3 - Gizmos.pdf", "lecture")];

  it("a lecture that is 90% one topic gives it about 90% of that lecture's minutes", () => {
    // 100 minutes: 90 on the Widgets deck, 10 on Gizmos; what he says names neither much.
    const l: LectureInput = { ...lecture("l1", "2026-09-01", talk(0, 100, "thing")), slideTimeline: [span(0, 2700, "2 - Widgets"), span(2700, 3300, "3 - Gizmos"), span(3300, 6000, "2 - Widgets")] };
    const t = buildCourseTape(base({ items: decks, lectures: [l] }));
    const w = stop(t, "widgets");
    const g = stop(t, "gizmos");
    expect(w.lectureMinutes).toBe(90);
    expect(g.lectureMinutes).toBe(10);
    expect(w.lectureMinutes / (w.lectureMinutes + g.lectureMinutes)).toBeCloseTo(0.9, 2);
    expect(w.stressed.evidence.find((e) => e.kind === "minutes")?.detail).toBe("90 min of lecture (its slides on screen)");
  });

  it("Discussion decks add no minutes, and keyword windows are only the fallback", () => {
    const withTimeline: LectureInput = { ...lecture("l1", "2026-09-01", talk(0, 30, "gizmo")), slideTimeline: [span(0, 600, "Discussion 2 - Widgets"), span(600, 1800, "2 - Widgets")] };
    const t = buildCourseTape(base({ items: decks, lectures: [withTimeline] }));
    // He says "gizmo" the whole time, but the slides say Widgets: 20 minutes of Widgets (not 30), none of Gizmos.
    expect(stop(t, "widgets").lectureMinutes).toBe(20);
    expect(stop(t, "gizmos").lectureMinutes).toBe(0);
    const noTimeline = buildCourseTape(base({ items: decks, lectures: [lecture("l1", "2026-09-01", talk(0, 30, "gizmo"))] }));
    expect(stop(noTimeline, "gizmos").lectureMinutes).toBe(30);
  });

  it("thin evidence never glows fully; below the floor it doesn't glow at all", () => {
    // 0.9 points of minutes only: under the floor, no glow.
    const thin = buildCourseTape(base({ lectures: [lecture("l1", "2026-09-01", talk(0, 9, "widget"))] }));
    expect(stop(thin, "widgets").stressed.score).toBe(0.9);
    expect(stop(thin, "widgets").stressed.heat).toBe(0);
    // Even the top topic on the tape: no more "the top stop always glows fully".
    expect(Math.max(...thin.stops.map((s) => s.stressed.heat))).toBe(0);
    // 90 minutes of nothing but lecture time: a medium glow at most.
    const many = buildCourseTape(base({ lectures: [lecture("l1", "2026-09-01", talk(0, 90, "widget"))] }));
    expect(stop(many, "widgets").stressed.score).toBe(9);
    expect(stop(many, "widgets").stressed.heat).toBe(STRESS.capWithoutFlag);
    expect(stressHeat([{ kind: "announcement", points: 1, quote: null, source: "Announcement", detail: "", at: null }])).toBe(0);
  });

  it("a full glow needs an exam or importance flag or a past review; a weaker flag clears the floor but not the cap", () => {
    const minutes = { kind: "minutes" as const, points: 6, quote: null, source: "Lecture", detail: "60 min of lecture", at: null };
    const flag = (k: string, points: number) => ({ kind: "radar" as const, points, quote: null, source: "Lecture", detail: "", at: null, flags: [k] });
    expect(stressHeat([minutes])).toBe(STRESS.capWithoutFlag);
    expect(stressHeat([minutes, flag("exam", 3)])).toBe(1);
    expect(stressHeat([minutes, flag("importance", 2)])).toBe(1);
    expect(stressHeat([minutes, { kind: "review", points: 2, quote: null, source: "Past review", detail: "", at: null }])).toBe(1);
    expect(stressHeat([minutes, flag("recall", 1)])).toBe(STRESS.capWithoutFlag);
    // A single weak flag (1 point) is under the floor in points, but it was flagged: it glows a little.
    expect(stressHeat([flag("recall", 1)])).toBeGreaterThan(0);
    expect(glowLevel(stressHeat([flag("recall", 1)]), 1)).toBeGreaterThan(0);
    expect(glowLevel(0, 0.9)).toBe(0);
  });

  it("clip-only lectures add no minutes to stressed: the glow then comes from flags and reviews only", () => {
    const clipOnly: LectureInput = { ...lecture("l1", "2026-09-01", talk(0, 40, "widget")), clipOnly: true };
    const t = buildCourseTape(base({ lectures: [clipOnly] }));
    const w = stop(t, "widgets");
    expect(w.stressed.evidence.filter((e) => e.kind === "minutes")).toEqual([]);
    expect(w.stressed.heat).toBe(0);
    expect(t.glowFrom).toBe("flags");
    // It still dates the topic.
    expect(w.firstTaughtAt).toBe("2026-09-01");
    const full = buildCourseTape(base({ lectures: [lecture("l1", "2026-09-01", talk(0, 40, "widget"))] }));
    expect(full.glowFrom).toBe("lectures");
  });

  it("derived per-topic numbers (no lecture text) count like the recordings would", () => {
    const t = buildCourseTape(base({ derived: [{ topic: "Gizmos", minutes: 50, flags: [{ kind: "exam", sec: 1200 }] }] }));
    const g = stop(t, "gizmos");
    expect(g.lectureMinutes).toBe(50);
    expect(g.stressed.evidence.every((e) => e.quote === null)).toBe(true);
    expect(g.stressed.heat).toBe(1);
    expect(t.glowFrom).toBe("lectures");
  });

  it("a derived flag names its lecture, so the stop sheet reads the date before the time", () => {
    const t = buildCourseTape(base({ derived: [{ topic: "Gizmos", lecture: "2026-10-13", minutes: 5, flags: [{ kind: "importance", sec: 33 }] }] }));
    expect(stop(t, "gizmos").stressed.evidence.find((e) => e.kind === "radar")).toMatchObject({ at: "2026-10-13", sec: 33 });
  });
});
