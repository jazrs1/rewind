import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DemoExamSlot } from "@/components/demo/DemoExamCard";
import { BUNDLE_DIR } from "./bundle";
import { demoExamCard, demoExamsEnabled, parseDemoExams } from "./exam-card";
import { buildDemoExams, EXAM_KEYS, EXAMS_FILE, quoteProblem, saysDay, saysTime, type DemoExamsFile, type FoundExamInput } from "./exams";

const field = <T>(value: T | null, quote: string | null, itemId: string | null = quote ? "announcement:1" : null) => ({ value, quote, itemId });
const found = (over: Partial<FoundExamInput>): FoundExamInput => ({ name: field(null, null), date: field(null, null), topics: field(null, null), ...over });
const Q2 = "Exams: Exam 1 and Exam 2 will be in-person on October 6 and November 18, 8:30-10:10 pm.";
const source = (text: string) => () => text;

describe("buildDemoExams", () => {
  it("keeps exams only, with the four fields, the date's sentence as the quote", () => {
    const { file, skipped } = buildDemoExams(
      "COP3530",
      [
        found({ name: field("Exam 2", Q2), date: field("2026-11-18T20:30:00-05:00", Q2) }),
        found({ name: field("CQ6 - Heaps", "CQ6 - Heaps due Oct 16"), date: field("2026-10-16", "CQ6 - Heaps due Oct 16") }),
      ],
      source(`Welcome! ${Q2} See you.`),
    );
    expect(file).toEqual({ course: "COP3530", exams: [{ date: "2026-11-18T20:30:00-05:00", title: "Exam 2", coverage: null, quote: Q2 }] });
    expect(skipped).toEqual({ "not an exam": 1 });
  });

  it("drops a field its quote doesn't say", () => {
    const q = "Exam 1 will be on Oct 6 (Tuesday) at 8:20 pm to 10:10 pm on campus in-person.";
    const { file } = buildDemoExams(
      "C",
      [
        found({
          name: field("Exam 1", q),
          date: field("2026-10-06T20:20:00-04:00", q),
          // Quoted from another sentence: not in the one quote that ships.
          topics: field(["Module 1-6"], "Exam 1 will test your knowledge on concepts from Module 1-6."),
        }),
        // The date's sentence doesn't name the exam, and its day isn't the one quoted.
        found({ name: field("Exam 3", "Exam 3 is in December."), date: field("2026-12-09", "The final is on Dec 8.") }),
      ],
      source(`${q} The final is on Dec 8. Exam 3 is in December.`),
    );
    expect(file.exams).toEqual([{ date: "2026-10-06T20:20:00-04:00", title: "Exam 1", coverage: null, quote: q }]);
  });

  it("keeps only the day when another source gives the same day another time", () => {
    const { file } = buildDemoExams(
      "C",
      [found({ name: field("Exam 2", Q2), date: field("2026-11-18T20:30:00-05:00", Q2), conflicts: [{ field: "date", other: { value: "2026-11-18T20:20:00-05:00" } }] })],
      source(Q2),
    );
    expect(file.exams[0].date).toBe("2026-11-18");
  });

  it("keeps the coverage the quote words; no date stays null", () => {
    const q = "There will be a common make-up for both exams covering all modules on the date of the final setup by the registrar.";
    const { file } = buildDemoExams("C", [found({ name: field("common make-up for both exams", q, "file:1"), topics: field(["all modules"], "covering all modules", "file:1") })], source(q));
    expect(file.exams).toEqual([{ date: null, title: "Common make-up for both exams", coverage: ["all modules"], quote: q }]);
  });

  it("throws on a quote that isn't word for word in its source", () => {
    expect(() => buildDemoExams("C", [found({ name: field("Exam 2", Q2), date: field("2026-11-18", Q2) })], source(Q2.replace("8:30", "8:20")))).toThrow(/word for word/);
    expect(() => buildDemoExams("C", [found({ name: field("Exam 2", Q2), date: field("2026-11-18", Q2) })], () => null)).toThrow(/word for word/);
  });

  it("leaves out a quote with a link, an id, a room or a listed name", () => {
    expect(quoteProblem("Quiz 1 (https://ufl.instructure.com/courses/424242/assignments/7255786) due Aug 28")).toBe("a link in the quote");
    expect(quoteProblem("Exam 1 in Pugh Hall 170")).toBe("a room in the quote");
    expect(quoteProblem("Exam 1 in TUR L005")).toBe("a room in the quote");
    expect(quoteProblem("Item 7255786")).toBe("an id in the quote");
    expect(quoteProblem("Ask Jordan about Exam 1", (s) => s.includes("Jordan"))).toBe("a name in the quote");
    expect(quoteProblem(Q2)).toBeNull();
  });

  it("reads the day and the 12-hour time", () => {
    expect(saysDay(Q2, "2026-11-18")).toBe(true);
    expect(saysDay("Oct 6 (Tuesday)", "2026-10-06")).toBe(true);
    expect(saysDay("Oct 16", "2026-10-06")).toBe(false);
    expect(saysTime(Q2, "2026-11-18T20:30:00-05:00")).toBe(true);
    expect(saysTime(Q2, "2026-11-18T20:20:00-05:00")).toBe(false);
  });
});

describe("the committed exams file (public/demo/course/exams.json)", () => {
  const file = JSON.parse(readFileSync(join(process.cwd(), "public", BUNDLE_DIR, EXAMS_FILE), "utf8")) as DemoExamsFile;

  it("carries exactly the four allowlisted keys per exam, and parses", () => {
    expect(Object.keys(file).sort()).toEqual(["course", "exams"]);
    expect(file.course).toBe("COP3530");
    expect(file.exams.length).toBeGreaterThan(0);
    for (const e of file.exams) expect(Object.keys(e).sort()).toEqual([...EXAM_KEYS].sort());
    expect(parseDemoExams(file)).toEqual(file);
    expect(() => parseDemoExams({ ...file, exams: [{ ...file.exams[0], room: "Hall 1" }] })).toThrow(/keys/);
  });

  it("has no rooms, URLs or Canvas ids", () => {
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/https?:|instructure|zoom\.us|\b\d{6,}\b|announcement:|file:|assignment:/);
    expect(text).not.toMatch(/\b(room|hall|building)\b/i);
    for (const e of file.exams) expect(quoteProblem(e.quote), e.quote).toBeNull();
  });

  it("each field it keeps is in its quote", () => {
    for (const e of file.exams) {
      const q = e.quote.toLowerCase();
      if (e.title) expect(q, e.quote).toContain(e.title.toLowerCase());
      if (e.date) expect(saysDay(e.quote, e.date.slice(0, 10)), e.quote).toBe(true);
      if (e.date && e.date.length > 10) expect(saysTime(e.quote, e.date), e.quote).toBe(true);
      for (const c of e.coverage ?? []) expect(q, e.quote).toContain(c.toLowerCase());
    }
  });

  // The course's own text is private (not in the repo, or CI): checked wherever private/ is there.
  const docsPath = join(process.cwd(), "private", "pipeline", "COP3530", "docs.json");
  it.skipIf(!existsSync(docsPath))("every quote is word for word in the course's source text", () => {
    const docs = JSON.parse(readFileSync(docsPath, "utf8")) as { pages?: { text: string }[] }[];
    const spaced = (s: string) => s.replace(/\s+/g, " ");
    const texts = docs.map((d) => spaced((d.pages ?? []).map((p) => p.text).join("\n")));
    for (const e of file.exams) expect(texts.some((t) => t.includes(spaced(e.quote).trim())), e.quote).toBe(true);
  });
});

describe("the demo exam card (NEXT_PUBLIC_REWIND_DEMO_EXAMS)", () => {
  const file: DemoExamsFile = {
    course: "COP3530",
    exams: [
      { date: "2026-10-06", title: "Exam 1", coverage: null, quote: "Exam 1 will be on Oct 6 (Tuesday) at 8:20 pm to 10:10 pm on campus in-person." },
      { date: "2026-11-18", title: "Exam 2", coverage: null, quote: Q2 },
    ],
  };
  const NOW = "2026-10-25T16:00:00.000Z";

  it("is off unless the flag is 1", () => {
    expect(demoExamsEnabled({})).toBe(false);
    expect(demoExamsEnabled({ NEXT_PUBLIC_REWIND_DEMO_EXAMS: "true" })).toBe(false);
    expect(demoExamsEnabled({ NEXT_PUBLIC_REWIND_DEMO_EXAMS: "1" })).toBe(true);
  });

  it("flag off renders nothing", () => {
    expect(renderToStaticMarkup(createElement(DemoExamSlot, { on: false, file, now: NOW }))).toBe("");
    expect(renderToStaticMarkup(createElement(DemoExamSlot, { on: true, file: null, now: NOW }))).toBe("");
  });

  it("flag on: the next exam's countdown and its quote", () => {
    expect(demoExamCard(file, NOW)).toMatchObject({ days: 24, text: "Exam 2 in 24 days", quote: Q2, exam: { title: "Exam 2" } });
    const html = renderToStaticMarkup(createElement(DemoExamSlot, { on: true, file, now: NOW }));
    expect(html).toContain("Exam 2");
    expect(html).toContain(">24<");
    expect(html).toContain(Q2);
    expect(html).toContain('data-field="Covers"');
    expect(html).not.toContain("Room");
    expect(html).not.toContain("data-sources-toggle");
  });

  it("no card once every dated exam is past", () => {
    expect(demoExamCard(file, "2026-11-19T16:00:00.000Z")).toBeNull();
  });
});
