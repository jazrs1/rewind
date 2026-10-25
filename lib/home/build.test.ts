// Course home builder, on invented data (no real course text).
import { describe, expect, it } from "vitest";
import type { SourceRef } from "../pipeline/types.ts";
import type { Sourced } from "../schema.ts";
import {
  buildHome,
  countdownOf,
  daysBetween,
  easternDate,
  formatExamDate,
  guessCoverage,
  modulesText,
  nextQuiz,
  readyText,
  sourceRows,
  tapePracticeLink,
  isMajorExam,
  modulesForLecture,
  phoneWindow,
  searchedText,
  timeAgo,
} from "./build.ts";
import { parseLectures, parseModules, practiceSelection, questionModule } from "./practice.ts";
import type { HomeExamInput, HomeInputs, HomeModuleInput } from "./types.ts";

const SEARCHED: SourceRef[] = [
  { kind: "syllabus", itemId: "syl", href: "https://canvas.example/syllabus" },
  { kind: "page", itemId: "pg1", pageUrl: "p1", title: "Course Calendar", href: "https://canvas.example/p1" },
  { kind: "page", itemId: "pg2", pageUrl: "p2", title: "Policies" },
  { kind: "announcement", itemId: "an1", title: "Week 4 Notes", postedAt: "2030-02-03T14:00:00Z", href: "https://canvas.example/a1" },
];

const S = <T,>(value: T, quote: string, itemId: string): Sourced<T> => ({ value, quote, itemId });
const NONE = <T,>(): Sourced<T> => ({ value: null, quote: null, itemId: null });

function exam(id: string, name: string | null, date: string | null, extra: Partial<HomeExamInput> = {}): HomeExamInput {
  return {
    id,
    name: name ? S(name, `${name} will be held`, "syl") : NONE(),
    date: date ? S(date, `on ${date}`, "an1") : NONE(),
    location: NONE(),
    topics: NONE(),
    searched: SEARCHED,
    ...extra,
  };
}

const MODULES: HomeModuleInput[] = [
  { id: "m1", position: 1, name: "Module 1", topic: "Pottery Basics", itemTitles: [], dates: [] },
  { id: "m2", position: 2, name: "Module 2", topic: "Glazes", itemTitles: [], dates: [] },
  { id: "m3", position: 3, name: "Module 3", topic: "Kilns and Firing", itemTitles: [], dates: [] },
  { id: "m4", position: 4, name: "Module 4", topic: null, itemTitles: [], dates: [] },
];

const repeat = (line: string, n: number) => Array.from({ length: n }, () => line);

describe("dates", () => {
  it("reads dates in Eastern time", () => {
    expect(easternDate("2030-03-01")).toBe("2030-03-01");
    // 02:00 UTC on Mar 2 is still Mar 1 in Florida.
    expect(easternDate("2030-03-02T02:00:00Z")).toBe("2030-03-01");
    expect(easternDate("nonsense")).toBeNull();
    expect(daysBetween("2030-02-27", "2030-03-02")).toBe(3);
  });

  it("says how long ago the course was imported", () => {
    const now = "2030-02-20T15:00:00Z";
    expect(timeAgo("2030-02-20T14:59:30Z", now)).toBe("just now");
    expect(timeAgo("2030-02-20T14:00:00Z", now)).toBe("1 hour ago");
    expect(timeAgo("2030-02-18T15:00:00Z", now)).toBe("2 days ago");
    expect(timeAgo(null, now)).toBeNull();
    expect(timeAgo("2030-02-21T15:00:00Z", now)).toBeNull();
  });

  it("formats an exam date with its time only when it has one", () => {
    expect(formatExamDate("2030-03-01")).toBe("Mar 1");
    expect(formatExamDate("2030-03-01T19:00:00-05:00")).toBe("Mar 1, 7 pm");
    expect(formatExamDate("2030-03-01T08:30:00-05:00")).toBe("Mar 1, 8:30 am");
  });
});

describe("countdown", () => {
  const now = "2030-02-20T15:00:00Z";

  it("counts to the next exam whose date is known, skipping quizzes and past exams", () => {
    const { countdown } = countdownOf(
      [
        exam("exam:exam-1", "Exam 1", "2030-02-01T19:00:00-05:00"),
        exam("exam:quiz-3", "Quiz 3", "2030-02-22"),
        exam("exam:exam-2", "Exam 2", "2030-03-01T19:00:00-05:00"),
        exam("exam:final-exam", "Final Exam", "2030-04-30T10:00:00-04:00"),
      ],
      now,
    );
    expect(countdown.kind).toBe("days");
    if (countdown.kind !== "days") return;
    expect(countdown.days).toBe(9);
    expect(countdown.text).toBe("Exam 2 in 9 days");
    expect(countdown.exam.date).toMatchObject({ state: "found", text: "Mar 1, 7 pm" });
    expect(countdown.exam.dateFrom).toBe("From an announcement");
  });

  it("counts Eastern calendar days: late evening is still today", () => {
    // 11:30 pm Eastern on Feb 28 is Mar 1 in UTC; the exam is tomorrow, not today.
    const { countdown } = countdownOf([exam("exam:exam-2", "Exam 2", "2030-03-01")], "2030-03-01T04:30:00Z");
    expect(countdown).toMatchObject({ kind: "days", days: 1, text: "Exam 2 in 1 day" });
    const today = countdownOf([exam("exam:exam-2", "Exam 2", "2030-03-01")], "2030-03-01T15:00:00Z").countdown;
    expect(today).toMatchObject({ kind: "days", days: 0, text: "Exam 2 is today" });
  });

  it("says so when no upcoming exam has a known date, and never uses a guessed one", () => {
    const { countdown } = countdownOf(
      [exam("exam:exam-1", "Exam 1", "2030-02-01"), exam("exam:exam-2", "Exam 2", null), exam("exam:quiz-4", "Quiz 4", "2030-02-25")],
      now,
    );
    expect(countdown).toMatchObject({ kind: "no-date", text: "Exam 2: date not found" });
    if (countdown.kind !== "no-date") return;
    expect(countdown.exam?.date).toEqual({ state: "missing", searched: "Looked in the syllabus, 2 Canvas pages and 1 announcement" });
    expect(countdownOf([], now).countdown).toEqual({ kind: "no-date", exam: null, text: "No exam date found" });
  });

  it("treats a value without its quote as not found", () => {
    const e = exam("exam:exam-2", "Exam 2", null, { date: { value: "2030-03-01", quote: null, itemId: "an1" } });
    expect(countdownOf([e], now).countdown.kind).toBe("no-date");
  });

  it("names each found field's source, with a link when the source has one", () => {
    const e = exam("exam:exam-2", "Exam 2", "2030-03-01", { location: S("Hall 100", "in Hall 100", "pg1") });
    const { countdown } = countdownOf([e], now);
    if (countdown.kind !== "days") throw new Error("expected days");
    expect(countdown.exam.name).toMatchObject({ state: "found", source: { label: "Syllabus", link: { label: "Open in Canvas" } } });
    expect(countdown.exam.location).toMatchObject({
      state: "found",
      text: "Hall 100",
      source: { label: "Canvas page · Course Calendar", link: { href: "https://canvas.example/p1" }, quote: "in Hall 100" },
    });
    expect(countdown.exam.date).toMatchObject({ source: { label: "“Week 4 Notes” announcement, Feb 3" } });
  });

  it("tells exams from quizzes by name, then by id", () => {
    expect(isMajorExam(exam("x", "Midterm II", null))).toBe(true);
    expect(isMajorExam(exam("x", "Quiz 2: Exam prep", null))).toBe(false);
    expect(isMajorExam(exam("exam:exam-3", null, null))).toBe(true);
    expect(isMajorExam(exam("exam:cq-3", null, null))).toBe(false);
  });

  it("describes where it looked", () => {
    expect(searchedText([])).toBe("No course sources were read");
    expect(searchedText(SEARCHED.slice(0, 1))).toBe("Looked in the syllabus");
  });
});

describe("tapes", () => {
  it("takes the module a lecture's opening names", () => {
    expect(modulesForLecture(["Welcome back.", "Today is module 3, which is kilns."], MODULES)).toEqual([3]);
    // A module the course doesn't have is ignored.
    expect(modulesForLecture(["This is module 9, which is something else."], MODULES)).toEqual([]);
  });

  it("adds every module whose topic words the lecture says often, so a lecture can span two", () => {
    const lines = [...repeat("Glazes go on before the kiln.", 30), ...repeat("The kiln reaches cone six when firing.", 12)];
    expect(modulesForLecture(lines, MODULES)).toEqual([2, 3]);
    // A passing mention isn't enough.
    expect(modulesForLecture([...repeat("glaze", 30), "kiln"], MODULES)).toEqual([2]);
  });

  it("builds one tape per module in order: recorded tapes link, blank ones don't", () => {
    const inputs: HomeInputs = {
      course: { code: "ART101", name: "Ceramics", importedAt: null },
      now: "2030-02-20T15:00:00Z",
      exams: [exam("exam:exam-2", "Exam 2", "2030-03-01", { topics: S(["Glazes", "Kiln safety"], "Glazes and kiln safety", "syl") })],
      modules: [MODULES[3], MODULES[0], MODULES[2], MODULES[1]],
      lectures: [
        { id: "l2", date: "2030-02-12", lines: repeat("Glazes again.", 25) },
        { id: "l1", date: "2030-02-10", lines: ["This is module 2, which is glazes."] },
        { id: "l3", date: "2030-02-14", lines: ["Module 3, which is kilns and firing."] },
      ],
      practice: [{ id: "q1", lectureDate: "2030-02-12", module: 2 }],
    };
    const home = buildHome(inputs);
    expect(home.tapes.map((t) => t.position)).toEqual([1, 2, 3, 4]);
    expect(home.tapes.map((t) => t.state)).toEqual(["blank", "recorded", "recorded", "blank"]);
    expect(home.tapes.map((t) => t.shell)).toEqual([null, 2, 3, null]);
    expect(home.tapes.map((t) => t.label)).toEqual(["Mod 1: Pottery Basics", "Mod 2: Glazes", "Mod 3: Kilns and Firing", "Module 4"]);
    expect(home.tapes[1].lectureDates).toEqual(["2030-02-10", "2030-02-12"]);
    // A tape opens practice for its own lecture, says which, and names its lecture without questions.
    expect(home.tapes[1].link).toEqual({ href: "/practice?lecture=2030-02-12", label: "Practice the Feb 12 lecture", note: "Feb 10: no questions yet" });
    expect(home.tapes[2].link).toEqual({ href: "/course/tape", label: "Open the course tape", note: "Feb 14: no questions yet" });
    expect(home.tapes[0].link).toBeNull();
    expect(home.tapes.map((t) => t.onNextExam)).toEqual([false, true, true, false]);
    expect(home.latestRecorded).toBe(2);
  });

  it("shows five tapes on the phone, ending one past the latest recording", () => {
    expect(phoneWindow(11, 9)).toEqual([6, 11]);
    expect(phoneWindow(11, 3)).toEqual([0, 5]);
    expect(phoneWindow(11, 6)).toEqual([3, 8]);
    expect(phoneWindow(11, -1)).toEqual([0, 5]);
    expect(phoneWindow(3, 2)).toEqual([0, 3]);
  });

  it("leaves 'on the next exam' unknown when the exam's topics weren't found", () => {
    const home = buildHome({
      course: { code: "ART101", name: null, importedAt: null },
      now: "2030-02-20T15:00:00Z",
      exams: [exam("exam:exam-2", "Exam 2", "2030-03-01")],
      modules: MODULES,
      lectures: [],
      practice: [],
    });
    expect(home.tapes.every((t) => t.onNextExam === null && t.state === "blank")).toBe(true);
    expect(home.latestRecorded).toBe(-1);
  });
});

describe("source lines", () => {
  it("merges found fields that share a source into one line; each missing field keeps its own", () => {
    const e = exam("exam:exam-2", "Exam 2", "2030-03-01", { name: S("Exam 2", "Exam 2 is on", "an1") });
    const { countdown } = countdownOf([e], "2030-02-20T15:00:00Z");
    if (countdown.kind !== "days") throw new Error("expected days");
    expect(countdown.exam.sources.map((s) => [s.label, s.field.state])).toEqual([
      ["Name and date", "found"],
      ["Room", "missing"],
    ]);
    const src = { label: "x", link: null, quote: "q" };
    const found = (itemId: string) => ({ state: "found" as const, text: "t", source: { ...src, itemId } });
    expect(sourceRows([["Name", found("a")], ["Date", found("a")], ["Room", found("a")]]).map((r) => r.label)).toEqual(["Name, date and room"]);
    expect(sourceRows([["Name", found("a")], ["Date", found("b")], ["Room", found("a")]]).map((r) => r.label)).toEqual(["Name and room", "Date"]);
  });
});

describe("quiz first", () => {
  const now = "2030-02-20T15:00:00Z";
  const quiz = (id: string, date: string | null, topics: string[] | null) =>
    exam(id, id.replace("exam:", "Quiz "), date, { topics: topics ? S(topics, topics.join(" and "), "an1") : NONE() });

  it("shows the nearest quiz before the exam whose date and topics were both found", () => {
    const exams = [quiz("exam:q4", "2030-02-26", ["Glazes"]), quiz("exam:q3", "2030-02-22", ["Kilns"]), exam("exam:exam-2", "Exam 2", "2030-03-01")];
    const q = nextQuiz(exams, now, "2030-03-01");
    expect(q).toMatchObject({ days: 2, text: "Quiz q3 in 2 days" });
    expect(q!.exam.topics).toMatchObject({ state: "found", text: "Kilns" });
    expect(q!.exam.sources.map((s) => s.label)).toEqual(["Name", "Date and covers"]);
    // The home puts it before the exam card.
    const home = buildHome({ course: { code: "ART101", name: null, importedAt: null }, now, exams, modules: MODULES, lectures: [], practice: [] });
    expect(home.quiz?.exam.id).toBe("exam:q3");
    expect(home.countdown.exam?.id).toBe("exam:exam-2");
  });

  it("uses a quiz's Canvas due date when no date is quoted, labelled as Canvas metadata, and practises the modules its topics name", () => {
    const searched: SourceRef[] = [...SEARCHED, { kind: "assignment", itemId: "as8", name: "Quiz 8", dueAt: "2030-02-27T23:59:00-05:00", href: "https://canvas.example/as8" }];
    const q8 = exam("exam:q8", "Quiz 8", null, { topics: S(["Glazes"], "about Glazes.", "pg1"), windowCloses: { value: "2030-02-27T23:59:00-05:00", itemId: "as8" }, searched });
    const q = nextQuiz([q8, exam("exam:exam-2", "Exam 2", "2030-03-01")], now, "2030-03-01", MODULES, [{ id: "a", lectureDate: null, module: 2 }]);
    expect(q).toMatchObject({ days: 7, text: "Quiz 8 in 7 days", exam: { dateKind: "canvas-due", dateFrom: "Due date from Canvas" } });
    expect(q!.exam.date).toEqual({
      state: "found",
      text: "Feb 27, 11:59 pm",
      source: { itemId: "as8", label: "Canvas due date (not a quote)", link: { href: "https://canvas.example/as8", label: "Open in Canvas" }, quote: null },
    });
    expect(q!.exam.sources.map((s) => s.label)).toEqual(["Name", "Due", "Covers"]);
    expect(q!.practice).toEqual({ modules: [2], href: "/practice?modules=2", ready: "Ready: Module 2" });
    // An exam never takes a Canvas due date as its date.
    const e2 = exam("exam:exam-2", "Exam 2", null, { windowCloses: { value: "2030-03-01T12:00:00-05:00", itemId: "as8" } });
    expect(countdownOf([e2], now).countdown.kind).toBe("no-date");
  });

  it("never merges a quoted source with Canvas metadata from the same item", () => {
    const src = (label: string, quote: string | null) => ({ state: "found" as const, text: "t", source: { itemId: "as8", label, link: null, quote } });
    expect(sourceRows([["Name", src("Canvas assignment · Quiz 8", "Quiz 8")], ["Due", src("Canvas due date (not a quote)", null)]]).map((r) => r.label)).toEqual(["Name", "Due"]);
  });

  it("skips quizzes without found topics, without a found date, already past, or after the exam", () => {
    expect(nextQuiz([quiz("exam:q3", "2030-02-22", null)], now, "2030-03-01")).toBeNull();
    expect(nextQuiz([quiz("exam:q3", null, ["Kilns"])], now, "2030-03-01")).toBeNull();
    expect(nextQuiz([quiz("exam:q3", "2030-02-19", ["Kilns"])], now, "2030-03-01")).toBeNull();
    expect(nextQuiz([quiz("exam:q5", "2030-03-04", ["Kilns"])], now, "2030-03-01")).toBeNull();
    expect(nextQuiz([quiz("exam:q5", "2030-03-04", ["Kilns"])], now, null)).not.toBeNull();
  });
});

describe("coverage guess", () => {
  const mod = (position: number, itemTitles: string[], dates: string[] = []): HomeModuleInput => ({ id: `m${position}`, position, name: `Module ${position}`, topic: null, itemTitles, dates });
  const COURSE = [
    mod(5, [], ["2030-01-20"]),
    mod(6, ["Review and Midterm 1"], ["2030-01-27"]),
    mod(7, [], ["2030-02-05"]),
    mod(8, []),
    mod(9, [], ["2030-02-20"]),
    mod(10, [], ["2030-03-10"]),
    mod(12, []),
  ];
  const prev = { name: "Midterm 1", day: "2030-01-30" };

  it("is the modules after the one holding the previous exam, up to the last dated before the next exam", () => {
    const { guess, noGuess } = guessCoverage(COURSE, new Map(), prev, { name: "Midterm 2", day: "2030-03-01" });
    expect(noGuess).toBeNull();
    expect(guess).toMatchObject({ since: "Midterm 1", positions: [7, 8, 9], label: "Everything since Midterm 1 (Modules 7 to 9)", leftOut: null });
    expect(guess!.why).toBe("Midterm 1 is in Module 6; Module 9 is the last module with a date before Midterm 2.");
  });

  it("counts lecture dates as module dates and leaves out trailing modules with no dates, saying so", () => {
    const { guess } = guessCoverage(COURSE.slice(0, 5).concat(mod(12, [])), new Map([[8, ["2030-02-12"]]]), prev, { name: "Midterm 2", day: "2030-04-01" });
    expect(guess).toMatchObject({ positions: [7, 8, 9], leftOut: "Module 12 has no dates yet, so it's left out." });
  });

  it("finds the previous exam's module by date when no module names it", () => {
    const plain = COURSE.map((m) => ({ ...m, itemTitles: [] }));
    const { guess } = guessCoverage(plain, new Map(), prev, { name: "Midterm 2", day: "2030-03-01" });
    expect(guess).toMatchObject({ positions: [7, 8, 9] });
    expect(guess!.why).toMatch(/^Midterm 1 falls during Module 6;/);
    // "Exam 1" never matches "Exam 10".
    const ten = [mod(1, ["Exam 10 review"]), mod(2, [], ["2030-02-01"])];
    expect(guessCoverage(ten, new Map(), { name: "Exam 1", day: "2030-01-01" }, { name: "Exam 2", day: "2030-03-01" }).guess).toBeNull();
  });

  it("says why instead of guessing when a piece isn't found", () => {
    expect(guessCoverage(COURSE, new Map(), null, { name: "Midterm 2", day: "2030-03-01" })).toEqual({ guess: null, noGuess: "No earlier exam has a date, so we can't guess what Midterm 2 covers." });
    expect(guessCoverage(COURSE, new Map(), prev, { name: "Midterm 2", day: null }).noGuess).toBe("Midterm 2's date wasn't found, so we can't guess what it covers.");
    expect(guessCoverage([mod(1, []), mod(2, [])], new Map(), prev, { name: "Midterm 2", day: "2030-03-01" }).noGuess).toBe("We couldn't tell which module Midterm 1 came after, so we won't guess.");
    expect(guessCoverage([mod(6, ["Midterm 1"]), mod(7, [])], new Map(), prev, { name: "Midterm 2", day: "2030-03-01" }).noGuess).toBe("No module after Midterm 1 has a date before Midterm 2, so we won't guess.");
  });

  it("home: unknown coverage offers the guess; found topics start exam practice", () => {
    const base = { course: { code: "ART101", name: null, importedAt: null }, now: "2030-02-20T15:00:00Z", modules: COURSE, lectures: [], practice: [] };
    const m1 = exam("exam:midterm-1", "Midterm 1", "2030-01-30");
    const home = buildHome({ ...base, exams: [m1, exam("exam:midterm-2", "Midterm 2", "2030-03-01")] });
    expect(home.coverage).toMatchObject({ kind: "unknown", text: "Midterm 2 topics: not found in the syllabus or announcements.", guess: { positions: [7, 8, 9] } });
    const known = buildHome({ ...base, exams: [m1, exam("exam:midterm-2", "Midterm 2", "2030-03-01", { topics: S(["Glazes"], "covers glazes", "syl") })] });
    expect(known.coverage).toEqual({ kind: "known", title: "Midterm 2", topics: ["Glazes"] });
  });

  it("names modules and what's ready, never claiming more than the practice set has", () => {
    expect(modulesText([9])).toBe("Module 9");
    expect(modulesText([10, 8, 9])).toBe("Modules 8 to 10");
    expect(modulesText([8, 10])).toBe("Modules 8, 10");
    expect(readyText([8, 9, 10], [9, 10])).toEqual({ ready: [9, 10], notYet: [8], text: "Ready: Modules 9–10 · not yet: 8" });
    expect(readyText([8], [9, 10])).toEqual({ ready: [], notYet: [8], text: "No questions yet for Module 8." });
    expect(readyText([], [9]).text).toBe("Pick at least one module.");
    expect(readyText([9], [9, 10]).text).toBe("Ready: Module 9");
  });

  it("ready modules are the ones with at least one question", () => {
    const home = buildHome({
      course: { code: "ART101", name: null, importedAt: null },
      now: "2030-02-20T15:00:00Z",
      exams: [],
      modules: MODULES,
      lectures: [
        { id: "l1", date: "2030-02-10", lines: ["Module 2, which is glazes."] },
        { id: "l2", date: "2030-02-12", lines: ["Module 3, which is kilns."] },
      ],
      practice: [
        { id: "q1", lectureDate: "2030-02-10", module: 2 },
        { id: "q2", lectureDate: "2030-02-10", module: null },
      ],
    });
    expect(home.ready).toEqual({ positions: [2], lectureDates: ["2030-02-10"] });
    expect(home.coverage).toMatchObject({ kind: "unknown", guess: null });
  });

  it("a tape with two practiced lectures opens both", () => {
    expect(tapePracticeLink(["2030-02-10", "2030-02-12"], [{ id: "a", lectureDate: "2030-02-10", module: 2 }, { id: "b", lectureDate: "2030-02-12", module: 2 }])).toEqual({
      href: "/practice?lecture=2030-02-10,2030-02-12",
      label: "Practice the Feb 10 and Feb 12 lectures",
      note: null,
    });
    expect(tapePracticeLink(["2030-02-10"], [])).toBeNull();
  });
});

describe("practice links", () => {
  const index = [
    { id: "a", lectureDate: "2030-02-10", module: 2 },
    { id: "b", lectureDate: "2030-02-12", module: 3 },
    { id: "c", lectureDate: "2030-02-12", module: 3 },
    { id: "d", lectureDate: null, module: null },
  ];

  it("?modules= picks the questions on those modules and says what's practised and not ready", () => {
    expect(practiceSelection(index, { modules: [2, 3, 4], lectures: null })).toEqual({ ids: ["a", "b", "c"], line: "Modules 2–3 · 3 questions · 3 with a clip: Feb 10 (1), Feb 12 (2) · not yet: 4" });
    expect(practiceSelection(index, { modules: [3], lectures: null })).toEqual({ ids: ["b", "c"], line: "Module 3 · 2 questions · 2 with a clip: Feb 12 (2)" });
    // A generated set: only some of the picked questions have a lecture clip, and the line says how many.
    expect(practiceSelection([...index, { id: "e", lectureDate: null, module: 3 }], { modules: [3], lectures: null })?.line).toBe("Module 3 · 3 questions · 2 with a clip: Feb 12 (2)");
    // Every clip counts, by lecture: one whose lecture date is unknown still plays a clip.
    expect(practiceSelection([...index, { id: "e", lectureDate: null, module: 3, clip: true }, { id: "f", lectureDate: "2030-02-14", module: 3, clip: true }, { id: "g", lectureDate: null, module: 3, clip: false }], { modules: [3], lectures: null })?.line).toBe("Module 3 · 5 questions · 4 with a clip: Feb 12 (2), Feb 14 (1), another lecture (1)");
    expect(practiceSelection(index, { modules: [4], lectures: null })).toEqual({ ids: [], line: "No questions yet for Module 4." });
  });

  it("?lecture= picks a lecture's questions", () => {
    expect(practiceSelection(index, { modules: null, lectures: ["2030-02-12", "2030-02-14"] })).toEqual({ ids: ["b", "c"], line: "The Feb 12 lecture · 2 questions · Feb 14: no questions yet" });
    expect(practiceSelection(index, { modules: null, lectures: null })).toBeNull();
  });

  it("parses query lists, dropping junk", () => {
    expect(parseModules("10,9,x,9")).toEqual([9, 10]);
    expect(parseModules(undefined)).toBeNull();
    expect(parseLectures("2030-02-12,nope")).toEqual(["2030-02-12"]);
  });

  it("puts a question on the module its words name most, or none on a tie", () => {
    expect(questionModule("Which glaze fires at cone six? glazes", MODULES)).toBe(2);
    expect(questionModule("glaze kiln", MODULES)).toBeNull();
    expect(questionModule("nothing here", MODULES)).toBeNull();
  });
});
