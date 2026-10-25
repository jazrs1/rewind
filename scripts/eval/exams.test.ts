import { describe, expect, it } from "vitest";
import { buildTemplate, courseTemplate, fieldCorrect, parseWhen, report, scoreTemplate, type ParsedExam, type Template, type TruthExam } from "./exams";

// Invented exams; no real course text.
const midterm: ParsedExam = {
  id: "exam:exam-1",
  name: { value: "Exam 1", quote: "Exam 1 is on Thursday" },
  date: { value: "2030-03-07T19:00:00-05:00", quote: "Exam 1 on March 7 at 7 PM" },
  topics: { value: ["Trees", "Hashing"], quote: "covers trees and hashing" },
  format: { value: null, quote: null },
  notesRule: { value: "handwritten", quote: "one handwritten page allowed" },
  location: { value: null, quote: null },
};
const quiz: ParsedExam = { id: "exam:quiz-3", name: { value: "Quiz 3", quote: "Quiz 3" } };

describe("courseTemplate", () => {
  it("lists every field with parsed, quote and an empty truth", () => {
    const [e] = courseTemplate([midterm]);
    expect(e.id).toBe("exam:exam-1");
    expect(e.date).toEqual({ parsed: "2030-03-07T19:00:00-05:00", quote: "Exam 1 on March 7 at 7 PM", truth: "" });
    expect(e.coverage).toEqual({ parsed: ["Trees", "Hashing"], quote: "covers trees and hashing", truth: "" });
    expect(e.notes.parsed).toBe("handwritten");
    expect(e.format).toEqual({ parsed: "not found", quote: null, truth: "" });
    expect(e.location.parsed).toBe("not found");
  });

  it("keeps filled truth, matched by id, then by name", () => {
    const prev = courseTemplate([midterm, quiz]);
    prev[0].date.truth = "2030-03-07T19:00-05:00";
    prev[0].format.truth = "";
    prev[1] = { ...prev[1], id: "exam:old-id" };
    prev[1].location.truth = "Room 101";
    const next = courseTemplate([{ ...midterm, date: { value: "2030-03-08", quote: "March 8" } }, quiz], prev);
    expect(next[0].date).toEqual({ parsed: "2030-03-08", quote: "March 8", truth: "2030-03-07T19:00-05:00" });
    expect(next[0].format.truth).toBe("");
    expect(next[1].id).toBe("exam:quiz-3");
    expect(next[1].location.truth).toBe("Room 101");
  });

  it("keeps a filled exam the parser no longer finds, all parsed values not found", () => {
    const prev = courseTemplate([midterm, quiz]);
    prev[1].name.truth = "Quiz 3";
    prev[0].name.truth = "";
    const next = courseTemplate([], prev);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "exam:quiz-3", notInLatestParse: true, name: { parsed: "not found", truth: "Quiz 3" } });
  });
});

describe("buildTemplate", () => {
  it("leaves a course with no parse this run as it was", () => {
    const prev: Template = { about: "", courses: { MAS3114: courseTemplate([quiz]) } };
    prev.courses.MAS3114[0].name.truth = "Quiz 3";
    const t = buildTemplate({ COP3530: [midterm] }, prev);
    expect(Object.keys(t.courses)).toEqual(["COP3530", "MAS3114"]);
    expect(t.courses.MAS3114).toBe(prev.courses.MAS3114);
  });
});

describe("parseWhen", () => {
  it("reads ISO days, offsets, Z, and naive Eastern times (EDT and EST)", () => {
    expect(parseWhen("2030-03-07")).toEqual({ day: "2030-03-07", ms: null });
    expect(parseWhen("2030-03-07T19:00:00-05:00")!.ms).toBe(Date.parse("2030-03-08T00:00:00Z"));
    expect(parseWhen("2030-03-08T00:00Z")!.ms).toBe(Date.parse("2030-03-08T00:00:00Z"));
    expect(parseWhen("2030-03-07 7:00 PM")!.ms).toBe(Date.parse("2030-03-08T00:00:00Z"));
    expect(parseWhen("2030-07-07T19:00")!.ms).toBe(Date.parse("2030-07-07T23:00:00Z"));
    expect(parseWhen("March 7")).toBeNull();
  });
});

describe("fieldCorrect", () => {
  it("dates: the same instant is correct, whatever the offset", () => {
    expect(fieldCorrect("date", "2030-03-07T19:00:00-05:00", "2030-03-08T00:00Z")).toBe(true);
    expect(fieldCorrect("date", "2030-03-07T19:00:00-05:00", "2030-03-07 7 :00 pm")).toBe(false);
    expect(fieldCorrect("date", "2030-03-07T19:00:00-05:00", "2030-03-07 7:00 pm")).toBe(true);
    expect(fieldCorrect("date", "2030-03-07T19:00:00-05:00", "2030-03-07T20:00-05:00")).toBe(false);
  });

  it("dates: a day matches only a day", () => {
    expect(fieldCorrect("date", "2030-03-07", "2030-03-07")).toBe(true);
    expect(fieldCorrect("date", "2030-03-07", "2030-03-07T19:00-05:00")).toBe(false);
    expect(fieldCorrect("date", "2030-03-07T19:00:00-05:00", "2030-03-07")).toBe(false);
  });

  it("ignores case and spacing", () => {
    expect(fieldCorrect("name", "Exam  1", " exam 1 ")).toBe(true);
    expect(fieldCorrect("format", "Multiple choice", "multiple choice, open response")).toBe(false);
  });

  it("coverage compares the topics as a set, list or comma-separated", () => {
    expect(fieldCorrect("coverage", ["Trees", "Hashing"], "hashing, trees")).toBe(true);
    expect(fieldCorrect("coverage", ["Trees", "Hashing"], ["trees"])).toBe(false);
  });

  it("not found is correct only against not found (or none)", () => {
    expect(fieldCorrect("location", "not found", "not found")).toBe(true);
    expect(fieldCorrect("location", "not found", "None")).toBe(true);
    expect(fieldCorrect("location", "not found", "Room 101")).toBe(false);
    expect(fieldCorrect("location", "Room 101", "not found")).toBe(false);
  });

  it("for the notes rule, none means no notes allowed", () => {
    expect(fieldCorrect("notes", "none", "none")).toBe(true);
    expect(fieldCorrect("notes", "not found", "none")).toBe(false);
    expect(fieldCorrect("notes", "not found", "not found")).toBe(true);
    expect(fieldCorrect("notes", "handwritten", "Handwritten")).toBe(true);
  });
});

describe("scoreTemplate", () => {
  it("scores only filled truth, per course and overall, listing the wrong ones", () => {
    const cop: TruthExam[] = courseTemplate([midterm]);
    cop[0].name.truth = "Exam 1";
    cop[0].date.truth = "2030-03-07T20:00-05:00";
    cop[0].format.truth = "not found";
    const mas: TruthExam[] = courseTemplate([quiz]);
    mas[0].name.truth = "quiz 3";
    mas[0].location.truth = "Room 101";
    const s = scoreTemplate({ about: "", courses: { COP3530: cop, MAS3114: mas } });
    expect(s).toMatchObject({ correct: 3, scored: 5, byCourse: { COP3530: { correct: 2, scored: 3 }, MAS3114: { correct: 1, scored: 2 } } });
    expect(s.wrong).toEqual([
      { course: "COP3530", exam: "Exam 1", field: "date", parsed: "2030-03-07T19:00:00-05:00", truth: "2030-03-07T20:00-05:00" },
      { course: "MAS3114", exam: "quiz 3", field: "location", parsed: "not found", truth: "Room 101" },
    ]);
    const text = report(s);
    expect(text).toMatch(/^3 of 5 fields correct\n {2}COP3530: 2 of 3 fields correct\n {2}MAS3114: 1 of 2 fields correct/);
    expect(text).toContain("parsed: not found");
  });
});
