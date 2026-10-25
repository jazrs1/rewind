// Import check builder, on invented data (no real course text).
import { describe, expect, it } from "vitest";
import type { HomeModuleInput } from "../home/types.ts";
import type { PipelineExam, SourceRef } from "../pipeline/types.ts";
import { acronym, buildImportCheck, examRows, fileRows, findGaps, names, namesByAcronym, pct, phraseCount, rowDetail, TEXT_MIN, type ImportCheckInputs } from "./build.ts";

const mod = (position: number, topic: string | null, itemTitles: string[] = []): HomeModuleInput => ({ id: `m${position}`, position, name: `Module ${position}`, topic, itemTitles, dates: [] });
const doc = (name: string, role = "lecture", text = "", hasText = true) => ({ name, role, hasText, problem: hasText ? null : "needs a download", text });
const q = (topic: string, source: string, clip = false, slide: "slide" | "document" | null = "slide") => ({ topic, source, clip, slide, fallback: clip ? null : "reading" });

describe("gaps", () => {
  const modules = [mod(1, "Pottery Basics"), mod(2, "Glazes and Firing"), mod(3, "Kiln Safety"), mod(4, "Wheel Throwing"), mod(5, "Review and Exam"), mod(6, null)];
  const docs = [
    doc("1 - PotteryBasics"),
    doc("2 - Glazes, Firing"),
    doc("3 - Kiln Safety", "lecture", "", false),
    doc("Quiz 4 - Wheel Throwing", "homework"),
    doc("Glazes_review"),
  ];
  const questions = [q("Glazes", "2 - Glazes, Firing", true)];

  it("names a module or topic when at least half its words appear (CamelCase split, plurals folded)", () => {
    expect(names("Pottery Basics", "1 - PotteryBasics")).toBe(true);
    expect(names("Glazes and Firing", "Glazes_review")).toBe(true);
    expect(names("Glazes and Firing", "Kiln notes")).toBe(false);
    // Nothing checkable (only general words): can't tell, never a guess.
    expect(names("Review and Exam", "anything")).toBeNull();
  });

  it("finds modules and exam topics with no material, or material but no questions, and says what it searched", () => {
    const { gaps, covered, searched } = findGaps(modules, ["Glazes", "Raku Firing 2"], docs, questions);
    expect(gaps.map((g) => [g.kind, g.label, g.text])).toEqual([
      ["module", "Mod 1: Pottery Basics", "No practice questions yet for Mod 1: Pottery Basics (1 file with text)."],
      ["module", "Mod 3: Kiln Safety", "No material found for Mod 3: Kiln Safety (1 file names it but isn't downloaded)."],
      // A homework title restating the topic isn't material.
      ["module", "Mod 4: Wheel Throwing", "No material found for Mod 4: Wheel Throwing."],
    ]);
    // "Raku Firing 2" is covered by the firing deck (half its words); Mod 2 and "Glazes" have files and questions.
    expect(covered).toBe(3);
    expect(searched).toBe("Searched 4 files' titles and text, 6 modules' items and 1 practice question");
  });

  // Regression (reviewer, Oct 24): two topics covered by material that doesn't share their name.
  it("a topic listed in a module's items is covered by that module's decks and their questions (the 'Binary Search Trees' case)", () => {
    const courseModules = [mod(3, "Shelves"), mod(4, "Cabinets", ["Quiz 4 - Cabinets, Drawers and Sliding Door Cabinets"])];
    const files = [doc("3 - Cabinets", "lecture", "A cabinet holds things."), doc("Discussion 4 - Cabinets and Hinges", "practice", "Hinges.")];
    const qs = [q("Cabinet doors", "3 - Cabinets"), q("Cabinet hinges", "3 - Cabinets"), q("Shelf depth", "Shelves deck")];
    const { gaps } = findGaps(courseModules, ["Sliding Door Cabinets"], files, qs);
    expect(gaps.filter((g) => g.label === "Sliding Door Cabinets")).toEqual([]);
  });

  it("a title using the topic's acronym covers it, and so does text that says it TEXT_MIN+ times (the 'Dynamic Programming' case)", () => {
    expect(acronym("Dynamic Programming")).toBe("DP");
    expect(acronym("Binary Search Trees")).toBe("BST");
    expect(acronym("Heaps")).toBeNull();
    expect(namesByAcronym("Lazy Evaluation", "Discussion 14_ LE and Complexity")).toBe(true);
    expect(namesByAcronym("Lazy Evaluation", "Sale prices")).toBe(false);
    const byAcronym = findGaps([], ["Lazy Evaluation"], [doc("Discussion 14_ LE and Complexity", "practice", "")], [q("Thunks", "Discussion 14_ LE and Complexity")]);
    expect(byAcronym.gaps).toEqual([]);
    // Text: "lazy evaluation" said 3 times in a deck titled otherwise.
    const text = "Lazy evaluation delays work. With lazy evaluations, ... lazy-evaluation again.";
    expect(phraseCount("Lazy Evaluation", text)).toBe(TEXT_MIN);
    const byText = findGaps([], ["Lazy Evaluation"], [doc("9 - Paradigms", "lecture", text)], []);
    expect(byText.gaps.map((g) => g.text)).toEqual(["No practice questions yet for Lazy Evaluation (1 file with text)."]);
    // Said only twice: not enough.
    expect(findGaps([], ["Lazy Evaluation"], [doc("9 - Paradigms", "lecture", "lazy evaluation, lazy evaluation")], []).gaps[0].text).toBe("No material found for Lazy Evaluation.");
  });
});

describe("files", () => {
  it("counts files by role and type, and says what happened to each in plain words", () => {
    const { rows, lines } = fileRows({
      downloads: [
        { role: "lecture", status: "local", ext: "pdf" },
        { role: "lecture", status: "failed", reason: "needs a signed URL: Canvas asked for a login (re-export)", ext: "pptx" },
        { role: "lecture", status: "failed", reason: "download disabled", ext: "pdf" },
        { role: "review", status: "local", ext: "pdf" },
        { role: "transcript", status: "failed", reason: "needs a signed URL: Canvas asked for a login (re-export)", ext: "pdf" },
      ],
      localUnmatched: 4,
    });
    expect(rows.map((r) => [r.label, r.types, r.total, r.local, r.off, r.failed])).toEqual([
      ["Lecture slides", "PDF 2, PPTX 1", 3, 1, 1, 1],
      ["Past exam reviews", "PDF 1", 1, 1, 0, 0],
      ["Transcripts", "PDF 1", 1, 0, 0, 1],
    ]);
    expect(rowDetail(rows[0])).toBe("3 (PDF 2, PPTX 1) · 1 local · 1 not downloaded (download is off) · 1 couldn't be fetched");
    expect(lines).toEqual([
      "2 files came from your local folder.",
      "1 file wasn't downloaded: download is off.",
      "2 files couldn't be fetched (needs a signed URL: Canvas asked for a login (re-export)).",
      "4 files in your local folder matched no course file.",
    ]);
    expect(fileRows({ downloads: [], localUnmatched: null }).lines).toEqual(["The pipeline's download plan wasn't found."]);
  });
});

describe("exams", () => {
  const searched: SourceRef[] = [
    { kind: "announcement", itemId: "a1", title: "Week 2", postedAt: "2030-01-10T12:00:00Z", href: "https://canvas.example/a1" },
    { kind: "assignment", itemId: "as9", name: "Quiz 9", dueAt: null, href: "https://canvas.example/as9" },
  ];
  const none = { value: null, quote: null, itemId: null };
  const exam = (over: Partial<PipelineExam> & { windowCloses?: { value: string; itemId: string } | null }) => ({
    id: "exam:midterm-1",
    courseId: "1",
    name: { value: "Midterm 1", quote: "Midterm 1 is", itemId: "a1" },
    date: { value: "2030-02-01T19:00:00-05:00", quote: "Feb 1 at 7", itemId: "a1" },
    location: none,
    format: { value: "Multiple choice", quote: "multiple choice", itemId: "a1" },
    notesRule: none,
    topics: none,
    searched,
    ...over,
  });
  const now = "2030-01-20T12:00:00Z";

  it("gives every field its source or not found, and lists the missing ones", () => {
    const { upcoming } = examRows([exam({})], now);
    const row = upcoming[0];
    expect(row.name).toBe("Midterm 1");
    expect(row.date).toEqual({ state: "found", text: "Feb 1, 7 pm", source: "“Week 2” announcement, Jan 10", link: { href: "https://canvas.example/a1", label: "Open in Canvas" } });
    expect(row.dateKind).toBe("quote");
    expect(row.missing).toBe("room, notes rule, topics");
    expect(row.searched).toBe("Looked in 1 announcement and 1 assignment");
  });

  it("puts the next one first, then exams with no date, then past ones (latest first)", () => {
    const rows = examRows(
      [
        exam({ id: "exam:midterm-2", name: { value: "Midterm 2", quote: "Midterm 2", itemId: "a1" }, date: { value: "2030-03-01", quote: "Mar 1", itemId: "a1" } }),
        exam({ id: "exam:quiz-0", name: { value: "Quiz 0", quote: "Quiz 0", itemId: "a1" }, date: { value: "2030-01-05", quote: "Jan 5", itemId: "a1" } }),
        exam({ id: "exam:final", name: { value: "Final Exam", quote: "Final", itemId: "a1" }, date: none }),
        exam({}),
        exam({ id: "exam:quiz-00", name: { value: "Quiz 00", quote: "Quiz 00", itemId: "a1" }, date: { value: "2030-01-02", quote: "Jan 2", itemId: "a1" } }),
      ],
      now,
    );
    expect(rows.upcoming.map((r) => r.id)).toEqual(["exam:midterm-1", "exam:midterm-2"]);
    expect(rows.undated.map((r) => r.id)).toEqual(["exam:final"]);
    expect(rows.past.map((r) => r.id)).toEqual(["exam:quiz-0", "exam:quiz-00"]);
    expect(rows.past.every((r) => r.past)).toBe(true);
  });

  it("a quiz with no quoted date uses its Canvas due date, labelled; an exam never does; a value without its quote is not found", () => {
    const quiz = exam({ id: "exam:quiz-9", name: { value: "Quiz 9", quote: "Quiz 9", itemId: "a1" }, date: { value: "2030-02-10", quote: null, itemId: "a1" }, windowCloses: { value: "2030-02-12T23:59:00-05:00", itemId: "as9" } });
    const final = exam({ id: "exam:final-exam", name: { value: "Final Exam", quote: "Final Exam", itemId: "a1" }, date: none, windowCloses: { value: "2030-04-30T12:00:00-04:00", itemId: "as9" } });
    const rows = examRows([quiz, final], now);
    expect(rows.upcoming[0]).toMatchObject({
      id: "exam:quiz-9",
      dateKind: "canvas-due",
      day: "2030-02-12",
      date: { state: "found", text: "Due Feb 12, 11:59 pm", source: "Canvas due date (not a quote)", link: { href: "https://canvas.example/as9", label: "Open in Canvas" } },
      missing: "room, notes rule, topics",
    });
    expect(rows.undated[0]).toMatchObject({ id: "exam:final-exam", date: { state: "missing" }, dateKind: null, missing: "date, room, notes rule, topics" });
  });
});

describe("questions", () => {
  it("counts kept, dropped, clips, slides vs document pages and fallbacks; percentages say not found with nothing to count", () => {
    const inp: ImportCheckInputs = {
      course: { code: "ART101", name: null, importedAt: null },
      ranAt: null,
      now: "2030-03-01T12:00:00Z",
      recordings: 2,
      downloads: [],
      localUnmatched: null,
      docs: [],
      canvas: { pages: 3, announcements: null, assignments: 2 },
      exams: [],
      modules: [],
      questions: [q("Glazes", "x", true, "slide"), q("Kilns", "y", false, "document"), q("Kilns", "z", false, "document")],
      generated: { kept: 3, dropped: 1 },
    };
    const c = buildImportCheck(inp);
    expect(c.questions).toEqual({ total: 3, kept: 3, dropped: 1, withClip: 1, withSlide: 1, withDocument: 2, fallbacks: [{ label: "point to a reading instead", count: 2 }] });
    expect(c.files.canvas).toEqual([
      { label: "Canvas pages", count: 3 },
      { label: "Announcements", count: null },
      { label: "Assignments", count: 2 },
    ]);
    expect(pct(1, 3)).toBe("33%");
    expect(pct(0, 0)).toBe("not found");
  });
});
