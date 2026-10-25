import { describe, expect, it } from "vitest";
import { chunkDocs, splitText } from "./chunk";
import type { ExtractedDoc } from "./types";

// Invented course text only.
const para = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ") + ".";

describe("splitText", () => {
  it("keeps short text whole", () => {
    expect(splitText("One line.\nTwo line.")).toEqual(["One line.\nTwo line."]);
  });

  it("cuts on paragraph boundaries under ~800 chars with ~100 chars of overlap", () => {
    const paras = [para(60, "alpha"), para(60, "beta"), para(60, "gamma"), para(60, "delta")]; // ~420 chars each
    const out = splitText(paras.join("\n"));
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(800 + 110);
    // Each chunk after the first opens with the tail of the previous one.
    for (let i = 1; i < out.length; i++) {
      const head = out[i].split("\n")[0];
      expect(out[i - 1].endsWith(head)).toBe(true);
      expect(head.length).toBeLessThanOrEqual(100);
      expect(head.length).toBeGreaterThan(50);
    }
    // Nothing lost: every paragraph's last word is in some chunk.
    for (const w of ["alpha59.", "beta59.", "gamma59.", "delta59."]) expect(out.some((c) => c.includes(w))).toBe(true);
  });

  it("splits a single huge paragraph at sentence ends", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about binary heaps and arrays.`).join(" ");
    const out = splitText(sentences);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0].endsWith(".")).toBe(true);
  });
});

describe("chunkDocs", () => {
  const exp = {
    course: { id: 7 },
    pages: [{ url: "week-1", title: "Week 1" }],
    announcements: [{ id: 9, title: "Action Items Week 3", posted_at: "2026-09-10T12:00:00Z" }],
    assignments: [{ id: 5, name: "Exam 2", due_at: "2026-11-05T23:00:00Z" }],
  };
  const docs: ExtractedDoc[] = [
    { itemId: "file:1", fileId: 1, name: "Lecture 1", role: "lecture", pages: [{ page: 1, text: "Heaps" }, { page: 2, text: "" }, { page: 3, text: "Insert" }] },
    { itemId: "file:2", fileId: 2, name: "Review 1", role: "review", pages: [{ page: 1, text: [para(150, "q"), para(150, "r"), para(150, "s")].join("\n") }] },
    { itemId: "syllabus:7", fileId: null, name: "Syllabus", role: "syllabus", pages: [{ page: 1, text: "Exam 1: Oct 1" }] },
    { itemId: "page:week-1", fileId: null, name: "Week 1", role: "unknown", pages: [{ page: 1, text: "Read chapter 1" }] },
    { itemId: "announcement:9", fileId: null, name: "Action Items Week 3", role: "admin", pages: [{ page: 1, text: "Quiz 3 due Friday" }] },
    { itemId: "assignment:5", fileId: null, name: "Exam 2", role: "homework", pages: [{ page: 1, text: "Exam 2\nDue: 2026-11-05T23:00:00Z" }] },
    { itemId: "file:3", fileId: 3, name: "Gone", role: "lecture", pages: [], problem: "needs a signed URL" },
  ];
  const chunks = chunkDocs(docs, exp);

  it("one chunk per non-empty slide, with the deck and a Canvas link", () => {
    const slides = chunks.filter((c) => c.source.kind === "slide");
    expect(slides.map((c) => c.id)).toEqual(["file:1#p1", "file:1#p3"]);
    expect(slides[0].source).toEqual({ kind: "slide", itemId: "file:1", fileId: 1, page: 1, deck: "Lecture 1", href: "https://ufl.instructure.com/courses/7/files/1#page=1" });
  });

  it("documents in ~800-char chunks with their page", () => {
    const review = chunks.filter((c) => c.source.kind === "document");
    expect(review.length).toBeGreaterThan(1);
    expect(review[0]).toMatchObject({ id: "file:2#p1c1", role: "review", source: { kind: "document", fileId: 2, page: 1, name: "Review 1" } });
  });

  it("syllabus, pages, announcements and assignments carry their own sources", () => {
    const by = (kind: string) => chunks.filter((c) => c.source.kind === kind).map((c) => c.source);
    expect(by("syllabus")).toEqual([{ kind: "syllabus", itemId: "syllabus:7", href: "https://ufl.instructure.com/courses/7/assignments/syllabus" }]);
    expect(by("page")).toEqual([{ kind: "page", itemId: "page:week-1", pageUrl: "week-1", title: "Week 1", href: "https://ufl.instructure.com/courses/7/pages/week-1" }]);
    expect(by("announcement")).toEqual([{ kind: "announcement", itemId: "announcement:9", title: "Action Items Week 3", postedAt: "2026-09-10T12:00:00Z", href: "https://ufl.instructure.com/courses/7/discussion_topics/9" }]);
    expect(by("assignment")).toEqual([{ kind: "assignment", itemId: "assignment:5", name: "Exam 2", dueAt: "2026-11-05T23:00:00Z", href: "https://ufl.instructure.com/courses/7/assignments/5" }]);
    expect(chunks.filter((c) => c.source.kind === "announcement")).toHaveLength(1);
  });

  it("a doc with no text makes no chunks", () => {
    expect(chunks.some((c) => c.id.startsWith("file:3"))).toBe(false);
  });
});
