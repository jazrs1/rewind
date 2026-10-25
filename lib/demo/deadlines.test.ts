import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLE_DIR } from "./bundle";
import { atOf, buildDeadlines, DEADLINE_KEYS, DEADLINE_KINDS, DEADLINE_SOURCES, DEADLINES_FILE, easternOffset, kindOf, sourceOf, type DeadlinesFile } from "./deadlines";

const exam = (id: string, name: string, date: string | null, itemId: string | null) => ({ id: `exam:${id}`, name: { value: name, itemId }, date: { value: date, itemId: date ? itemId : null } });

describe("buildDeadlines", () => {
  it("kind from the title: exams (and the make-up), programming quizzes, quizzes", () => {
    expect(kindOf("Exam 1")).toBe("exam");
    expect(kindOf("common make-up for both exams")).toBe("exam");
    expect(kindOf("Programming Quiz 8 - Graphs 1")).toBe("programming-quiz");
    expect(kindOf("PQ2A - Algorithm Analysis - Coding")).toBe("programming-quiz");
    expect(kindOf("CQ5 - Balanced Trees")).toBe("quiz");
    expect(kindOf("Conceptual Quiz 2 - Algorithm Analysis")).toBe("quiz");
  });

  it("source from the item it was found in", () => {
    expect(sourceOf("announcement:5337209", [])).toBe("Announcement");
    expect(sourceOf("file:108457224", ["file:108457224"])).toBe("Syllabus");
    expect(sourceOf("assignment:7255783", [])).toBe("Canvas due date");
    expect(sourceOf("page:module-10", [])).toBe("Canvas due date");
  });

  it("a bare date is due 11:59 pm Eastern with that day's offset; a date-time keeps its own; none stays null", () => {
    expect(easternOffset("2026-10-23")).toBe("-04:00");
    expect(easternOffset("2026-11-18")).toBe("-05:00");
    expect(atOf("2026-08-28")).toBe("2026-08-28T23:59:00-04:00");
    expect(atOf("2026-12-01")).toBe("2026-12-01T23:59:00-05:00");
    expect(atOf("2026-10-06T20:20:00-04:00")).toBe("2026-10-06T20:20:00-04:00");
    expect(atOf(null)).toBeNull();
    expect(atOf("Aug 28")).toBeNull();
  });

  it("one row per item, ids without the finder's prefix, nothing but the five fields", () => {
    const f = buildDeadlines("COP3530", [exam("exam-1", "Exam 1", "2026-10-06T20:20:00-04:00", "announcement:1"), exam("exam-1", "Exam 1", null, null), exam("cq9", "Conceptual Quiz 9", null, "assignment:2")], []);
    expect(f).toEqual({
      course: "COP3530",
      deadlines: [
        { id: "exam-1", title: "Exam 1", kind: "exam", at: "2026-10-06T20:20:00-04:00", source: "Announcement" },
        { id: "cq9", title: "Conceptual Quiz 9", kind: "quiz", at: null, source: "Canvas due date" },
      ],
    });
  });
});

describe("the committed deadlines file (public/demo/course/deadlines.json)", () => {
  const file = JSON.parse(readFileSync(join(process.cwd(), "public", BUNDLE_DIR, DEADLINES_FILE), "utf8")) as DeadlinesFile;

  it("is COP3530's 24 quizzes and exams, in the allowlisted shape only", () => {
    expect(Object.keys(file).sort()).toEqual(["course", "deadlines"]);
    expect(file.course).toBe("COP3530");
    expect(file.deadlines).toHaveLength(24);
    const ids = new Set<string>();
    for (const d of file.deadlines) {
      expect(Object.keys(d).sort(), d.id).toEqual([...DEADLINE_KEYS].sort());
      expect(ids.has(d.id), d.id).toBe(false);
      ids.add(d.id);
      expect(DEADLINE_KINDS).toContain(d.kind);
      expect(DEADLINE_SOURCES).toContain(d.source);
      if (d.at !== null) expect(d.at, d.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    }
    expect(file.deadlines.filter((d) => d.kind === "exam").map((d) => d.title)).toEqual(["Exam 1", "Exam 2", "Common make-up for both exams"]);
  });

  it("carries no quotes, descriptions, rooms, URLs or Canvas ids", () => {
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/https?:|instructure|zoom\.us|\b\d{6,}\b/);
    expect(text).not.toMatch(/\b(room|hall|building|on campus|honorlock|notes allowed|multiple choice)\b/i);
    for (const d of file.deadlines) expect(d.title.length, d.id).toBeLessThanOrEqual(90);
  });
});
