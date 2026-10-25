// The Ask tab's tools on invented data (lib/ask/demo.ts fixtureAskCourses) and the demo bundle: nicknames, Eastern
// date ranges (a month boundary, the Nov 1, 2026 DST change), the honest no-date answer, a mixed practice set that
// never includes a graded question, chips that pass the answer check, and the server step's checks with the fake model.
import { beforeAll, describe, expect, it } from "vitest";
import { readDemoBundle, type DemoBundle } from "../demo/bundle";
import { fixtureOutput, fixtureTranscripts } from "../pipeline/fixtures/practice-real";
import { toPracticeSeed } from "../pipeline/run";
import { addDays, easternDay, easternStart, resolveDay, resolveRange } from "./dates";
import { buildDeadlines, examSummary, listDeadlines, deadlinesForModel, noDateLine } from "./deadlines";
import { demoAskCourses } from "./demo";
import { fixtureAskCourses } from "./fixture";
import { fakeAsk } from "./fake";
import { chipsFor } from "./ground";
import { gradedMention } from "./guide";
import { nicknamesOf, resolveCourse } from "./nicknames";
import { getQuestions } from "./questions";
import { parseSaved, type SavedAsk } from "./saved";
import { readDemoAskSaved } from "../demo/bundle";
import { searchCourse } from "./search";
import { askStep, checkClaims, cleanAskInput, ROUNDS_USED_UP } from "./service";
import { runTool } from "./tools";
import type { AskCourse, ToolCall } from "./types";

const seed = toPracticeSeed(fixtureOutput, fixtureTranscripts).seed;
const NOW = Date.parse("2026-10-24T16:00:00-04:00");
const courses = fixtureAskCourses(seed, NOW);
const empty: Omit<ToolCall, "tool"> = { course: "", courses: [], query: "", from: "", to: "", kinds: [], topics: [], n: 0, exam: "" };
const call = (tool: ToolCall["tool"], o: Partial<ToolCall> = {}): ToolCall => ({ ...empty, ...o, tool });

let bundle: DemoBundle;
let demo: AskCourse[];
let DEMO_EXAMPLES: SavedAsk[];
beforeAll(async () => {
  bundle = (await readDemoBundle())!;
  demo = demoAskCourses(bundle);
  DEMO_EXAMPLES = parseSaved(await readDemoAskSaved());
});

describe("nicknames", () => {
  it("derives initials, short forms, the code's parts and the lecturer", () => {
    const dsa = nicknamesOf("COP3530", "Data Structures and Algorithms", "Kapoor");
    expect(dsa).toEqual(expect.arrayContaining(["cop3530", "cop", "3530", "dsa", "data structures", "kapoor"]));
    const mas = nicknamesOf("MAS3114", "Computational Linear Algebra");
    expect(mas).toEqual(expect.arrayContaining(["mas", "linear algebra", "lin alg", "linalg", "cla"]));
  });
  it("resolves what students call their courses, and says when it can't tell", () => {
    const code = (n: string) => {
      const r = resolveCourse(n, courses);
      return "course" in r ? r.course.code : "ambiguous" in r ? "ambiguous" : "none";
    };
    expect(code("DSA")).toBe("COP3530");
    expect(code("dsa")).toBe("COP3530");
    expect(code("COP 3530")).toBe("COP3530");
    expect(code("data structures")).toBe("COP3530");
    expect(code("MAS")).toBe("MAS3114");
    expect(code("lin alg")).toBe("MAS3114");
    expect(code("linear algebra")).toBe("MAS3114");
    expect(code("Rivera")).toBe("MAS3114");
    expect(code("my DSA class")).toBe("COP3530");
    expect(code("organic chemistry")).toBe("none");
    const twins = [
      { code: "MAS3114", title: "Computational Linear Algebra", nicknames: nicknamesOf("MAS3114", "Computational Linear Algebra") },
      { code: "MAS4105", title: "Linear Algebra 1", nicknames: nicknamesOf("MAS4105", "Linear Algebra 1") },
    ];
    expect("ambiguous" in resolveCourse("MAS", twins)).toBe(true);
    expect(resolveCourse("MAS4105", twins)).toEqual({ course: twins[1] });
  });
  it("cleans a Canvas name with the code and term in it", () => {
    expect(demo[0].title).toBe("Data Structures and Algorithms");
    expect(demo[0].nicknames).toEqual(expect.arrayContaining(["dsa", "kapoor", "cop3530"]));
  });
});

describe("dates, in America/New_York from the real clock", () => {
  it("counts a range across a month boundary", () => {
    const now = Date.parse("2026-10-28T09:00:00-04:00");
    expect(resolveRange("today", "+7d", now, "")).toMatchObject({ from: "2026-10-28", to: "2026-11-04", label: "Oct 28 – Nov 4" });
    expect(resolveRange("today", "end_of_month", now, "")).toMatchObject({ to: "2026-10-31" });
    expect(resolveRange("start_of_next_month", "end_of_next_month", now, "")).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(resolveRange("today", "+2w", Date.parse("2026-12-24T12:00:00-05:00"), "")).toMatchObject({ to: "2027-01-07" });
  });
  it("uses the Eastern day, not UTC's, late at night", () => {
    // 11:30 pm EDT on Oct 24 is already Oct 25 in UTC.
    const late = Date.parse("2026-10-25T03:30:00Z");
    expect(easternDay(late)).toBe("2026-10-24");
    expect(resolveRange("today", "today", late, "")).toMatchObject({ from: "2026-10-24", to: "2026-10-24" });
  });
  it("handles the Nov 1, 2026 DST change (2 am EDT → 1 am EST)", () => {
    expect(new Date(easternStart("2026-10-31")).toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(new Date(easternStart("2026-11-01")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(easternStart("2026-11-02")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    // 11:30 pm EST on Nov 1 is 04:30Z on Nov 2: still Nov 1 (a fixed -4 h offset would say Nov 2, 00:30).
    expect(easternDay("2026-11-02T04:30:00Z")).toBe("2026-11-01");
    const now = Date.parse("2026-10-31T23:30:00-04:00");
    const c: AskCourse = {
      ...courses[1],
      deadlines: buildDeadlines({
        assignments: [
          { id: 1, name: "Sunday night quiz", due_at: "2026-11-02T04:30:00Z", points_possible: 5, is_quiz_assignment: true },
          { id: 2, name: "Monday morning homework", due_at: "2026-11-02T05:30:00Z", points_possible: 5 },
        ],
      }).deadlines,
    };
    const r = listDeadlines([c], { from: "tomorrow", to: "tomorrow", kinds: [], course: "" }, now, "");
    if ("error" in r) throw new Error(r.error);
    expect(r.rows.map((x) => [x.title, x.day, x.daysLeft, x.date])).toEqual([["Sunday night quiz", "2026-11-01", 1, "Sun, Nov 1 · 11:30 pm"]]);
    const week = listDeadlines([c], { from: "today", to: "+3d", kinds: [], course: "" }, now, "");
    if ("error" in week) throw new Error(week.error);
    expect(week.rows.map((x) => x.left)).toEqual(["tomorrow", "in 2 days"]);
  });
  it("never takes a date the model worked out; only one the student named", () => {
    expect(resolveDay("2026-11-07", "2026-10-24", "what's due in the next 2 weeks?")).toHaveProperty("error");
    expect(resolveDay("2026-11-07", "2026-10-24", "anything due by Nov 7?")).toEqual({ day: "2026-11-07" });
    expect(resolveDay("2026-11-07", "2026-10-24", "due by 11/7")).toEqual({ day: "2026-11-07" });
    expect(resolveDay("2026-11-30", "2026-10-24", "what's in November")).toEqual({ day: "2026-11-30" });
    expect(resolveDay("2027-01-31", "2026-10-24", "exams in January")).toEqual({ day: "2027-01-31" });
    expect(resolveDay("next fortnight", "2026-10-24", "")).toHaveProperty("error");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("list_deadlines", () => {
  it("lists the next 2 weeks soonest first, one row per item, with course, days left and Graded", () => {
    const r = listDeadlines(courses, { from: "today", to: "+14d", kinds: ["exam", "quiz", "assignment"], course: "" }, NOW, "What exams do I have in the next 2 weeks?");
    if ("error" in r) throw new Error(r.error);
    expect(r.range).toMatchObject({ from: "2026-10-24", to: "2026-11-07" });
    expect(r.rows.map((x) => [x.code, x.title, x.left, x.graded])).toEqual([
      ["COP3530", "Quiz 4 - Hashing", "in 3 days", true],
      ["MAS3114", "Quiz 6", "in 6 days", true],
      ["MAS3114", "Practice problems (ungraded)", "in 8 days", false],
      ["COP3530", "Exam 2", "in 9 days", true],
      ["COP3530", "Homework 5: Heaps", "in 12 days", true],
    ]);
    // A graded row opens guide mode (no link); an ungraded one its course's practice (MAS3114 has none: the card asks).
    expect(r.rows.filter((x) => x.graded).every((x) => x.href === null)).toBe(true);
    expect(r.rows.find((x) => x.title === "Practice problems (ungraded)")!.href).toBeNull();
    expect(examSummary(r)).toBe("1 exam: Exam 2, Mon Nov 2, in 9 days. Also due: 3 graded items and 1 more.");
    expect(examSummary({ rows: r.rows.filter((x) => x.kind !== "exam"), range: r.range })).toBe("No exams Oct 24 – Nov 7. Also due: 3 graded items and 1 more.");
    expect(r.rows[0].shell).toBe(1);
    expect(r.rows[1].shell).toBe(2);
  });
  it("gives the honest no-date answer, with where it looked, and never a guessed date", () => {
    const r = listDeadlines(courses, { from: "today", to: "+14d", kinds: ["exam"], course: "MAS" }, NOW, "When is my lin alg final?");
    if ("error" in r) throw new Error(r.error);
    expect(r.rows).toEqual([]);
    const m = deadlinesForModel(r) as { no_date: string[]; nothing_found: string[]; items: unknown[] };
    expect(m.no_date).toEqual(["No date for Final Exam in your MAS3114 Canvas data (looked in: Syllabus, Canvas announcements, Canvas assignments)."]);
    expect(m.nothing_found[0]).toMatch(/^Nothing dated Oct 24 – Nov 7 in your MAS3114 Canvas data \(looked in: /);
    expect(JSON.stringify(m)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(noDateLine("Exam 3", "COP3530", [])).toBe("No date for Exam 3 in your COP3530 Canvas data.");
  });
  it("on the demo before its deadlines file lands: said plainly", () => {
    const r = runTool(call("list_deadlines", { from: "today", to: "+14d" }), { courses: demo, now: NOW, studentText: "What exams do I have in the next 2 weeks?" });
    expect(r.result).toContain("Nothing dated Oct 24 – Nov 7 in your COP3530 Canvas data (looked in: the demo's deadlines file (not in this build yet)).");
  });
  it("refuses a range the model computed itself", () => {
    const r = runTool(call("list_deadlines", { from: "2026-10-24", to: "2026-11-07" }), { courses, now: NOW, studentText: "What's due in the next 2 weeks?" });
    expect(JSON.parse(r.result).error).toMatch(/didn't name 2026-10-24/);
    expect(r.display.kind).toBe("none");
  });
});

describe("get_questions: a mixed practice set", () => {
  it("never includes a graded item's question, and says when a course has no question bank", () => {
    const graded = new Set(courses[0].bank!.gradedIds);
    expect(graded.size).toBeGreaterThan(0);
    for (const n of [1, 3, 6, 10]) {
      const r = getQuestions(courses, { courses: ["DSA", "MAS"], topics: [], n }, () => []);
      expect(r.picked.length).toBeGreaterThan(0);
      expect(r.picked.every((p) => !graded.has(p.question.id))).toBe(true);
      expect(r.gradedLeftOut).toBe(graded.size);
      expect(r.noBank).toEqual([{ code: "MAS3114", has: ["1 lecture transcript", "2 dated deadlines"] }]);
    }
    const t = runTool(call("get_questions", { courses: ["dsa", "lin alg"], n: 4 }), { courses, now: NOW, studentText: "" });
    const m = JSON.parse(t.result);
    expect(m.no_question_bank).toEqual(["MAS3114 has no question bank yet; it has 1 lecture transcript, 2 dated deadlines."]);
    expect(t.result).not.toMatch(/"answer"|"explanation"/);
  });
  it("ranks by stressed × missed, then the student's own misses", () => {
    const bank = courses[0].bank!;
    const ids = bank.seed.questions.filter((q) => !bank.gradedIds.includes(q.id)).map((q) => q.id);
    const missed = ids[ids.length - 1];
    const q = bank.seed.questions.find((x) => x.id === missed)!;
    const attempts = [1, 2].map((i) => ({ questionId: missed, topic: q.match.slide.deck, stem: q.stem, correct: false, answeredAt: `2026-10-2${i}T12:00:00Z`, example: false }));
    const r = getQuestions(courses, { courses: ["DSA"], topics: [], n: 3 }, () => attempts);
    expect(r.picked[0].question.id).toBe(missed);
    expect(r.picked[0].priority).toBeGreaterThanOrEqual(r.picked[1].priority);
  });
  it("takes turns between courses that both have banks", () => {
    const two = [demo[0], { ...courses[0], id: "COP3530X", code: "COP3531", title: "Advanced Data Structures", nicknames: ["ads"] }];
    const r = getQuestions(two, { courses: ["COP3530", "ads"], topics: [], n: 4 });
    expect(r.picked.map((p) => p.code)).toEqual(["COP3530", "COP3531", "COP3530", "COP3531"]);
  });
});

describe("search_course and chips", () => {
  it("finds what Kapoor said about load factor on the demo, and every saved example's quote is found", () => {
    const r = searchCourse(demo, { course: "Kapoor", query: "load factor" });
    expect(r.hits[0].passage.kind).toBe("lecture");
    for (const ex of DEMO_EXAMPLES) {
      const hits = ex.calls.flatMap((c, i) => (c.tool === "search_course" ? searchCourse(demo, c, undefined, `r1c${i + 1}`).hits : []));
      const chips = chipsFor(ex.claims, hits, demo, { open: [], graded: [] });
      expect(chips.length, ex.prompt).toBe(ex.claims.length);
      expect(chips.every((c) => c.grounded.kind === "lecture" && c.moment?.date)).toBe(true);
    }
  });
  it("never returns a poll or answer slide", () => {
    const c: AskCourse = { ...courses[0], material: [{ kind: "slide", deck: "D", page: 2, pageKind: "slide", text: "Poll question: what is the load factor here?", href: null }, ...courses[0].material] };
    expect(searchCourse([c], { course: "", query: "load factor" }).hits.every((h) => h.passage.kind !== "slide" || !/Poll/.test(h.passage.text))).toBe(true);
  });
  it("drops a chip whose quote gives away an unanswered card's answer", () => {
    const q = demo[0].bank!.seed.questions.find((x) => x.id === "l20261013-q1")!;
    const hits = searchCourse(demo, { course: "DSA", query: "pivot swap elements compare" }).hits;
    const slide = hits.find((h) => h.passage.kind === "slide" && /pivot/i.test(h.passage.text));
    expect(slide).toBeTruthy();
    // A run of words from the question's own slide quote (read from the bundle, not written here).
    const quote = q.source!.quote.split(/\s+/).slice(4, 12).join(" ");
    expect(chipsFor([{ quote, source: slide!.id }], hits, demo, { open: [], graded: [] })).toHaveLength(1);
    expect(chipsFor([{ quote, source: slide!.id }], hits, demo, { open: [q], graded: [] })).toHaveLength(0);
  });
});

describe("guide mode on graded work, from the Canvas data", () => {
  it("names an open graded quiz, exam or assignment, never an ungraded item", () => {
    expect(gradedMention("can you help me with quiz 4 question 2?", courses, NOW)).toMatchObject({ code: "COP3530", title: "Quiz 4 - Hashing" });
    expect(gradedMention("hw5 is confusing", courses, NOW)).toMatchObject({ title: "Homework 5: Heaps" });
    expect(gradedMention("help me study for Exam 2", courses, NOW)).toMatchObject({ title: "Exam 2" });
    expect(gradedMention("Help me practice graphs and hash tables", courses, NOW)).toBeNull();
    expect(gradedMention("Practice problems (ungraded) question 1", courses, NOW)).toBeNull();
    expect(gradedMention("quiz 4", courses, Date.parse("2026-11-20T12:00:00-05:00"))).toBeNull();
  });
});

describe("the server step (fake model)", () => {
  it("asks for list_deadlines first, then answers without writing a date", async () => {
    const gen = fakeAsk({ delayMs: 0 });
    const message = "What exams do I have in the next 2 weeks?";
    const first = await askStep({ message, history: [], rounds: [], guide: null }, gen);
    expect(first.kind).toBe("tools");
    const calls = (first as { calls: ToolCall[] }).calls;
    expect(calls[0]).toMatchObject({ tool: "list_deadlines", from: "today", to: "+2w" });
    const results = calls.map((c) => runTool(c, { courses, now: NOW, studentText: message }).result);
    const second = await askStep({ message, history: [], rounds: [{ calls, results }], guide: null }, gen);
    expect(second).toMatchObject({ kind: "answer" });
    // Exams first, then what else is due: a line written in code, which the answer starts with.
    expect((second as { text: string }).text).toBe("1 exam: Exam 2, Mon Nov 2, in 9 days. Also due: 3 graded items and 1 more.");
  });
  it("stops after 3 tool rounds", async () => {
    const r = await askStep(
      { message: "x", history: [], rounds: [1, 2, 3].map(() => ({ calls: [call("list_courses")], results: ["{}"] })), guide: null },
      async () => ({ tool_calls: [call("list_courses")], text: "", claims: [] }),
    );
    expect(r).toEqual({ kind: "answer", text: ROUNDS_USED_UP, claims: [] });
  });
  it("keeps only claims found word for word in the passage they cite", () => {
    const passages = new Map([["r1c1p1", "the load factor is the number of keys divided by the number of buckets"]]);
    expect(
      checkClaims(
        [
          { quote: "the number of keys divided by the number of buckets", source: "r1c1p1" },
          { quote: "the number of keys divided by the number of slots", source: "r1c1p1" },
          { quote: "the number of keys divided by the number of buckets", source: "r1c1p9" },
          { quote: "load factor", source: "r1c1p1" },
        ],
        passages,
      ),
    ).toEqual([{ quote: "the number of keys divided by the number of buckets", source: "r1c1p1" }]);
  });
  it("declines anything outside the student's courses and studying", async () => {
    const r = await askStep({ message: "tell me a joke about the weather", history: [], rounds: [], guide: null }, fakeAsk({ delayMs: 0 }));
    expect(r).toMatchObject({ kind: "answer", text: expect.stringMatching(/only help with your courses/) });
  });
  it("cleans the request: unknown tools and oversized parts are dropped", () => {
    const i = cleanAskInput({ message: "  hi ".padEnd(900, "x"), history: [{ role: "system", text: "x" }, { role: "student", text: "a" }], rounds: [{ calls: [{ tool: "rm_rf" }], results: ["{}"] }], guide: { title: 1 } });
    expect(i).toMatchObject({ history: [{ role: "student", text: "a" }], rounds: [], guide: null });
    expect(i!.message.length).toBe(500);
    expect(cleanAskInput({ message: "" })).toBeNull();
  });
});

describe("pre-answer chips (the PR #3 rule)", () => {
  it("never shows the moment that explains an unanswered card's answer, nor its own slide; it does once answered", () => {
    const q = demo[0].bank!.seed.questions.find((x) => x.id === "l20261013-q1")!;
    // The demo's quicksort example quotes lines inside q1's clip.
    const ex = DEMO_EXAMPLES.find((e) => /quicksort/i.test(e.prompt))!;
    const hits = ex.calls.flatMap((c, i) => (c.tool === "search_course" ? searchCourse(demo, c, undefined, `r1c${i + 1}`).hits : []));
    expect(chipsFor(ex.claims, hits, demo, { open: [], graded: [] }).length).toBe(2);
    expect(chipsFor(ex.claims, hits, demo, { open: [q], graded: [] })).toEqual([]);
    // A graded question's moment is never shown.
    expect(chipsFor(ex.claims, hits, demo, { open: [], graded: [q] })).toEqual([]);
    // The slide it's answered from never shows before answering either.
    const slideHits = searchCourse(demo, { course: "DSA", query: "pivot swap elements compare" }).hits;
    const slide = slideHits.find((h) => h.passage.kind === "slide" && h.passage.deck === q.match.slide.deck && h.passage.page === q.match.slide.page)!;
    const own = q.source!.quote.split(/\s+/).slice(0, 8).join(" ");
    expect(chipsFor([{ quote: own, source: slide.id }], slideHits, demo, { open: [], graded: [] })).toHaveLength(1);
    expect(chipsFor([{ quote: own, source: slide.id }], slideHits, demo, { open: [q], graded: [] })).toEqual([]);
  });
});

describe("the demo: COP3530 only, deadlines.json", () => {
  it("has one course and the cross-course example isn't on it", () => {
    expect(demo.map((c) => c.code)).toEqual(["COP3530"]);
    expect(DEMO_EXAMPLES).toHaveLength(3);
    expect(DEMO_EXAMPLES.map((e) => e.prompt)).toContain("Help me practice graphs and hash tables");
    expect(JSON.stringify(DEMO_EXAMPLES)).not.toMatch(/MAS|lin(?:ear)? alg/i);
  });
  it("practises graphs and hash tables taking turns, from the one course", () => {
    const r = getQuestions(demo, { courses: ["COP3530"], topics: ["graphs", "hash tables"], n: 6 });
    expect(r.picked).toHaveLength(6);
    const kind = (p: (typeof r.picked)[number]) => (/graph/i.test(p.question.match.slide.deck) ? "graphs" : /hash/i.test(p.question.match.slide.deck) ? "hash" : "other");
    expect(r.picked.map(kind)).toEqual(["graphs", "hash", "graphs", "hash", "graphs", "hash"]);
  });
});

describe("deadlines.json (the demo bundle's shape; a fixture until the real file lands)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { deadlinesFromFile, validateDeadlinesFile } = await import("./demo-deadlines");
  const file = JSON.parse(await readFile(new URL("./fixtures/deadlines.json", import.meta.url), "utf8"));

  it("is a sound file, and so is the bundle's when it is there", async () => {
    expect(validateDeadlinesFile(file, "COP3530")).toEqual([]);
    const real = new URL("../../public/demo/course/deadlines.json", import.meta.url);
    if (existsSync(real)) expect(validateDeadlinesFile(JSON.parse(await readFile(real, "utf8")), "COP3530")).toEqual([]);
  });
  it("names every row that doesn't fit, and leaves it out", () => {
    const bad = { course: "COP3530", deadlines: [{ id: "x", title: "Quiz", kind: "homework", at: "2026-10-30", source: "Canvas", room: "CSE" }] };
    expect(validateDeadlinesFile(bad)).toEqual([
      "deadlines[0]: kind homework is not quiz, programming-quiz or exam",
      "deadlines[0]: at must be an ISO date-time with its offset, or null",
      "deadlines[0]: source must be one of Announcement, Syllabus, Canvas due date",
      "deadlines[0]: unexpected room",
    ]);
    expect(deadlinesFromFile(bad)).toEqual([]);
  });
  it("lists the next 2 weeks from `at` against now: Graded quiz and exam rows, past items out, no hardcoded dates", () => {
    const c = demoAskCourses(bundle, file);
    expect(c[0].deadlines.every((d) => d.graded && d.href === null)).toBe(true);
    const r = listDeadlines(c, { from: "today", to: "+14d", kinds: [], course: "" }, NOW, "What's due in the next 2 weeks?");
    if ("error" in r) throw new Error(r.error);
    expect(r.rows.map((x) => [x.title, x.kind, x.left, x.graded, x.date])).toEqual([
      ["Programming Quiz 6 - Hash Map", "programming-quiz", "in 3 days", true, "Tue, Oct 27 · 11:59 pm"],
      ["Conceptual Quiz 8 - Graphs 1", "quiz", "in 6 days", true, "Fri, Oct 30 · 11:59 pm"],
      ["Conceptual Quiz 9 - Graphs 2", "quiz", "in 13 days", true, "Fri, Nov 6 · 11:59 pm"],
    ]);
    // A week later the window has moved with the clock.
    const later = listDeadlines(c, { from: "today", to: "+14d", kinds: ["exam"], course: "" }, Date.parse("2026-11-10T10:00:00-05:00"), "");
    if ("error" in later) throw new Error(later.error);
    expect(later.rows.map((x) => [x.title, x.left])).toEqual([["Exam 2", "in 8 days"]]);
    expect(later.undated).toEqual([{ code: "COP3530", title: "Final Exam", kind: "exam" }]);
    expect((deadlinesForModel(later) as { no_date: string[] }).no_date).toEqual(["No date for Final Exam in your COP3530 Canvas data (looked in: Canvas due dates, announcements, the syllabus)."]);
  });
  it("a Graded row's title puts the turn in guide mode", () => {
    const c = demoAskCourses(bundle, file);
    expect(gradedMention("Guide me on Conceptual Quiz 8 - Graphs 1", c, NOW)).toMatchObject({ title: "Conceptual Quiz 8 - Graphs 1" });
    expect(gradedMention("cq8 question 2?", c, NOW)).toMatchObject({ title: "Conceptual Quiz 8 - Graphs 1" });
    expect(gradedMention("cq7", c, NOW)).toBeNull(); // already past
  });
});

describe("example prompts name courses the way students do", () => {
  it("prefers the code prefix, except an 'A and B' title's acronym; the other names still resolve when typed", async () => {
    const { exampleName, examplesFor } = await import("./examples");
    expect(exampleName({ code: "MAS3114", title: "Computational Linear Algebra" })).toBe("MAS");
    expect(exampleName({ code: "COP3530", title: "Data Structures and Algorithms" })).toBe("DSA");
    expect(exampleName({ code: "PHY2049", title: "Physics with Calculus 2" })).toBe("PHY");
    expect(examplesFor(courses)[1]).toBe("Help me practice for DSA and MAS");
    for (const typed of ["CLA", "cla", "Computational Linear Algebra", "MAS", "MAS3114"]) expect(resolveCourse(typed, courses)).toEqual({ course: courses[1] });
  });
});

describe("review fixes: no answer through search, guide mode carries forward", () => {
  it("for every demo question, while it is an open card, no passage search returns for its own stem gives its answer away", async () => {
    const { guardedOf } = await import("./tools");
    const { revealsAnswer } = await import("../tutor/integrity");
    const qs = demo[0].bank!.seed.questions;
    const text = (h: { passage: { kind: string; text?: string; lines?: { text: string }[] } }) => (h.passage.kind === "lecture" ? h.passage.lines!.map((l) => l.text).join(" ") : h.passage.text!);
    // Without the guard the leak is real (the reviewer's repro: 12 of 35)...
    const leaking = qs.filter((q) => searchCourse(demo, { course: "", query: q.stem }).hits.some((h) => revealsAnswer(text(h), q)));
    expect(leaking.length).toBeGreaterThan(0);
    // ...and with the question open, none.
    for (const q of qs) {
      const hits = searchCourse(demo, { course: "", query: q.stem }, undefined, "", guardedOf(demo, [q.id])).hits;
      for (const h of hits) expect(revealsAnswer(text(h), q), `${q.id}: ${h.id}`).toBe(false);
      // Nor anything inside the clip that explains it.
      const m = q.match as unknown as { start: number; end: number };
      const date = demo[0].bank!.moments[q.id]?.date;
      for (const h of hits) if (h.passage.kind === "lecture" && h.passage.date === date) expect(h.passage.lines.some((l) => l.end > m.start - 1 && l.start < m.end + 1), q.id).toBe(false);
    }
    // Answered (no longer open), the same passages may come back.
    expect(qs.some((q) => searchCourse(demo, { course: "", query: q.stem }, undefined, "", guardedOf(demo, [])).hits.some((h) => revealsAnswer(text(h), q)))).toBe(true);
  });
  it("the search tool takes the open cards from its context", () => {
    const q = demo[0].bank!.seed.questions.find((x) => x.id === "l20261013-q1")!;
    const open = runTool(call("search_course", { query: q.stem }), { courses: demo, now: NOW, studentText: "", openIds: [q.id] });
    const free = runTool(call("search_course", { query: q.stem }), { courses: demo, now: NOW, studentText: "" });
    expect(open.result).not.toBe(free.result);
  });
  it("guide mode carries forward through the student's earlier turns, and tolerates a typo in the name (never the number)", () => {
    expect(gradedMention("just give me the answer to question 2", courses, NOW)).toBeNull();
    expect(gradedMention("just give me the answer to question 2", courses, NOW, ["help with Quiz 4", "ok"])).toMatchObject({ title: "Quiz 4 - Hashing" });
    expect(gradedMention("help with qiuz 4", courses, NOW)).toMatchObject({ title: "Quiz 4 - Hashing" });
    expect(gradedMention("homewrk 5 question 1", courses, NOW)).toMatchObject({ title: "Homework 5: Heaps" });
    expect(gradedMention("help with quiz 5", courses, NOW)).toBeNull();
    expect(gradedMention("what's the answer", courses, NOW, ["What exams do I have in the next 2 weeks?"])).toBeNull();
  });
});
