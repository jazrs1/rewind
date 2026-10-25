import { describe, expect, it } from "vitest";
import { SYLLABUS_PARSE_SCHEMA, VERSION, syllabusParsePrompt } from "./syllabus-parse";

describe("syllabus-parse prompt", () => {
  it("is versioned and lists every source with its id", () => {
    expect(VERSION).toBe("syllabus-parse@2");
    const p = syllabusParsePrompt("Fake DS", [
      { id: "syllabus:7", label: "syllabus", text: "Exam 1 is on Oct 1." },
      { id: "announcement:9", label: "announcement posted 2026-09-10", text: "Exam 1 moved to Oct 3." },
    ]);
    expect(p).toContain('<source id="syllabus:7" kind="syllabus">\nExam 1 is on Oct 1.\n</source>');
    expect(p).toContain('<source id="announcement:9" kind="announcement posted 2026-09-10">');
    expect(p).toMatch(/copied exactly, character for character/);
    expect(p).toMatch(/Never infer a date/);
  });

  it("asks for every field with a quote and a source id", () => {
    const item = (SYLLABUS_PARSE_SCHEMA.properties.exams.items as { required: string[]; properties: Record<string, { required: string[] }> });
    expect(item.required).toEqual(["name", "date", "location", "format", "notesRule", "topics"]);
    for (const f of item.required) expect(item.properties[f].required).toEqual(["value", "quote", "sourceId"]);
  });
});
