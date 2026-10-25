import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baseName, classify, fileLinksIn, groupVersions, isImage, normalizeCourse, versionKey, words } from "./normalize";
import type { CourseExport, ImportItem } from "./types";

// Made-up courses: no real course content.
function load(name: string): CourseExport {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as CourseExport;
}

const byId = (items: ImportItem[]) => new Map(items.map((i) => [i.fileId, i]));

describe("helpers", () => {
  it("baseName drops the extension and one -N duplicate suffix", () => {
    expect(baseName("Lecture 4-1.pdf")).toBe("lecture 4");
    expect(baseName("Lecture 4.pdf")).toBe("lecture 4");
    expect(baseName("Lecture_4.PPTX")).toBe("lecture 4");
  });

  it("isImage checks content type and extension", () => {
    expect(isImage("banner.PNG", null)).toBe(true);
    expect(isImage("header", "image/jpeg")).toBe(true);
    expect(isImage("slides.pdf", "application/pdf")).toBe(false);
  });

  it("classify uses filename first, then module name, else unknown", () => {
    expect(classify("Syllabus.pdf", ["Lecture Slides"])).toEqual({ role: "syllabus", reason: "filename matches syllabus" });
    expect(classify("Practice Exam 2.pdf", [])).toMatchObject({ role: "review" });
    expect(classify("Worksheet_5.pdf", [])).toMatchObject({ role: "practice" });
    expect(classify("Lec 07.pdf", [])).toMatchObject({ role: "lecture" });
    expect(classify("Lecture_04.pdf", [])).toMatchObject({ role: "lecture" });
    expect(classify("Grading Policy.pdf", [])).toMatchObject({ role: "admin" });
    expect(classify("a.pdf", ["Week 2", "Exam Review"])).toEqual({
      role: "review",
      reason: 'module "Exam Review" matches review or past exam',
    });
    expect(classify("solutions.pdf", ["Week 2"])).toEqual({ role: "unknown", reason: null });
  });

  it("fileLinksIn finds href, data-api-endpoint and img links, with names", () => {
    const html =
      '<a title="A &amp; B.pdf" href="/courses/9/files/1?wrap=1">x</a>' +
      '<a href="https://h/courses/9/files/2/download"><span>Two.pdf</span></a>' +
      '<a data-api-endpoint="https://h/api/v1/courses/9/files/3">Three</a>' +
      '<img src="/courses/9/files/4/preview"><a href="/courses/9/files/2">again</a>';
    expect(fileLinksIn(html)).toEqual([
      { fileId: 1, name: "A & B.pdf", image: false },
      { fileId: 2, name: "Two.pdf", image: false },
      { fileId: 3, name: "Three", image: false },
      { fileId: 4, name: null, image: true },
    ]);
  });
});

describe("Files tab layout", () => {
  const out = normalizeCourse(load("files-layout.course.json"));
  const items = byId(out.items);

  it("keeps the PDF over the PPTX of the same deck", () => {
    expect(items.has(2)).toBe(false);
    expect(items.get(1)?.mergedFileIds).toEqual([2]);
  });

  it("dedupes by name ignoring -1 suffixes plus size, keeping the unsuffixed copy", () => {
    expect(items.has(4)).toBe(false);
    expect(items.get(3)?.mergedFileIds).toEqual([4]);
  });

  it("does not merge same-name files of different sizes", () => {
    expect(items.has(5)).toBe(true);
    expect(items.has(6)).toBe(true);
  });

  it("skips images by content type and extension", () => {
    expect(out.skipped).toEqual([
      { fileId: 12, name: "banner.png", reason: "image" },
      { fileId: 13, name: "header", reason: "image" },
    ]);
  });

  it("assigns each role", () => {
    const role = (id: number) => items.get(id)?.role;
    expect(role(1)).toBe("lecture");
    expect(role(7)).toBe("review");
    expect(role(8)).toBe("review");
    expect(role(9)).toBe("practice");
    expect(role(10)).toBe("syllabus");
    expect(role(11)).toBe("admin");
    expect(role(14)).toBe("unknown");
    expect(role(5)).toBe("unknown");
    // No filename rule; set by its module "Lecture Slides".
    expect(items.get(17)).toMatchObject({ role: "lecture", roleReason: 'module "Lecture Slides" matches lecture or slides' });
  });

  it("records where each file was found and keeps Files tab metadata", () => {
    expect(items.get(1)).toMatchObject({
      name: "Lecture 1 - Intro.pdf",
      contentType: "application/pdf",
      size: 1000,
      url: "/courses/1001/files/1",
      foundIn: [{ kind: "files" }, { kind: "module", moduleId: 1, moduleName: "Lecture Slides" }],
    });
    expect(items.get(7)?.foundIn).toEqual([{ kind: "files" }]);
    expect(out.items).toHaveLength(11); // 15 files - 2 images - PPTX - "-1" copy
  });
});

describe("Modules and Pages layout (no Files tab)", () => {
  const exp = load("modules-layout.course.json");
  const out = normalizeCourse(exp);
  const items = byId(out.items);

  it("finds files through page links and module File items", () => {
    expect(exp.files).toHaveLength(0);
    expect([...items.keys()].sort((a, b) => a - b)).toEqual([301, 304, 305, 306, 307, 308]);
  });

  it("keeps the PDF over the linked PPTX", () => {
    expect(items.has(302)).toBe(false);
    expect(items.get(301)?.mergedFileIds).toEqual([302]);
  });

  it("skips a file embedded only as an image", () => {
    expect(out.skipped).toEqual([{ fileId: 303, name: "file 303", reason: "image" }]);
  });

  it("records every page and module a file was found in", () => {
    expect(items.get(301)?.foundIn).toEqual([
      { kind: "page", pageUrl: "week-1-materials", pageTitle: "Week 1 materials", moduleId: 10, moduleName: "Week 1" },
      { kind: "page", pageUrl: "exam-1-prep", pageTitle: "Exam 1 prep", moduleId: 11, moduleName: "Exam Review" },
    ]);
    expect(items.get(305)?.foundIn).toEqual([{ kind: "module", moduleId: 12, moduleName: "Practice Problems" }]);
    // A page that no module links to is still scanned.
    expect(items.get(307)?.foundIn).toEqual([
      { kind: "page", pageUrl: "contacts", pageTitle: "Contacts", moduleId: null, moduleName: null },
    ]);
  });

  it("names files from the anchor title, else its text, and leaves size unknown", () => {
    expect(items.get(304)).toMatchObject({ name: "Course Syllabus.pdf", size: null, contentType: null });
    expect(items.get(307)?.name).toBe("Office Hours & Contacts.pdf");
  });

  it("assigns roles from filenames and module names", () => {
    const role = (id: number) => items.get(id)?.role;
    expect(role(301)).toBe("lecture");
    expect(role(304)).toBe("syllabus");
    expect(role(305)).toBe("practice"); // module "Practice Problems"
    expect(role(306)).toBe("review"); // module "Exam Review"
    expect(role(307)).toBe("admin");
    expect(role(308)).toBe("unknown");
  });
});

// ---------- T15: rules from the shapes of real exports (invented names, same shapes) ----------

describe("T15 role rules", () => {
  it("words splits CamelCase and letter/digit boundaries", () => {
    expect(words("Exam1Review")).toBe("Exam 1 Review");
    expect(words("Exam2ReviewAnswers")).toBe("Exam 2 Review Answers");
    expect(words("Unit3Review")).toBe("Unit 3 Review");
    expect(words("PDFNotes_v2")).toBe("PDF Notes v 2");
    expect(words("M4_2_ABC1234_F25_Doe")).toBe("M 4 2 ABC 1234 F 25 Doe");
  });

  const role = (name: string, modules: string[] = []) => classify(name, modules);

  it("transcripts, in any case, beat every other rule", () => {
    expect(role("M2_3_ABC1234_F25_Doe_transcript.pdf")).toEqual({ role: "transcript", reason: "filename matches transcript" });
    expect(role("M2_3_ABC1234_Roe_Transcript.pdf").role).toBe("transcript");
    expect(role("U1_2_XYZ9876_Poe_transcript.pdf", ["Unit One"]).role).toBe("transcript");
    expect(role("Exam Review_transcript.pdf").role).toBe("transcript");
  });

  it("study guides, CamelCase reviews, answers and a bare ExamN are review", () => {
    expect(role("M4_ABC1234_study_guide.pdf")).toEqual({ role: "review", reason: "filename matches study guide" });
    expect(role("M4_ABC1234_study_guide_fixed.docx").role).toBe("review");
    expect(role("Unit2Review.pdf")).toMatchObject({ role: "review", reason: "filename matches review or past exam" });
    expect(role("Exam1Review.pdf").role).toBe("review");
    expect(role("Exam1ReviewAnswers.pdf").role).toBe("review");
    expect(role("Exam2.pdf")).toEqual({ role: "review", reason: "filename matches past exam (Exam N)" });
    expect(role("Exam 3.pdf").role).toBe("review");
    // Not a bare exam: a word after the number.
    expect(role("Exam2 schedule.pdf").role).toBe("admin");
  });

  it("slide versions, module-numbered decks, numbered decks and L# in a module are lecture", () => {
    expect(role("M2_3_ABC1234_F25_Doe_accessible.pdf")).toEqual({ role: "lecture", reason: "filename matches slide version (accessible or revised)" });
    expect(role("M2_3_ABC1234_f25_Doe_revised.pptx").role).toBe("lecture");
    expect(role("M2_3_ABC1234_F25_Doe.pptx")).toEqual({ role: "lecture", reason: "filename matches module-numbered deck (M#_#_)" });
    expect(role("M2_3_ABC1234_F25_Doe (1).pptx").role).toBe("lecture");
    expect(role("5 - Widgets, Gadgets, Sprockets.pdf")).toEqual({ role: "lecture", reason: "filename matches numbered deck (N - Topic)" });
    expect(role("6b - Sprocket Traversals_revised.pptx").role).toBe("lecture");
    expect(role("L7.pdf", ["Unit Two"])).toEqual({ role: "lecture", reason: "filename matches lesson (L#) in a module" });
    expect(role("L7.pdf", [])).toEqual({ role: "unknown", reason: null });
  });

  it("keywords still win over shapes, and shapes never come from module names", () => {
    expect(role("Discussion 4 - Widgets.pdf").role).toBe("practice");
    expect(role("Exam 2 - Review B.pdf").role).toBe("review");
    expect(role("Gadgets_review_revised.pdf").role).toBe("review");
    expect(role("M4_ABC1234_study_guide_revised.pdf").role).toBe("review");
    expect(role("0 - Syllabus.pdf").role).toBe("syllabus");
    expect(role("notes.pdf", ["M2_3_Things", "Exam2", "L4"])).toEqual({ role: "unknown", reason: null });
  });

  it("module names see the new keywords", () => {
    expect(role("a.pdf", ["Unit3Review"])).toEqual({ role: "review", reason: 'module "Unit3Review" matches review or past exam' });
    expect(role("a.pdf", ["Lecture Transcripts"]).role).toBe("transcript");
  });
});

describe("T15 deck versions", () => {
  function item(fileId: number, name: string, extra: Partial<ImportItem> = {}): ImportItem {
    const { role, reason } = classify(name, []);
    return { fileId, name, contentType: null, size: 1, url: `/courses/1/files/${fileId}`, role, roleReason: reason, foundIn: [{ kind: "files" }], mergedFileIds: [], ...extra };
  }

  it("versionKey drops accessible/revised and the extension, keeps order and -N", () => {
    expect(versionKey("M2_3_ABC1234_F25_Doe_accessible.pdf")).toEqual({ key: "m 2 3 abc 1234 f 25 doe", suffix: "accessible" });
    expect(versionKey("M2_3_ABC1234_f25_Doe_revised.pptx")).toEqual({ key: "m 2 3 abc 1234 f 25 doe", suffix: "revised" });
    expect(versionKey("M2_3_ABC1234_F25_Doe.pptx")).toEqual({ key: "m 2 3 abc 1234 f 25 doe", suffix: null });
    expect(versionKey("M4_ABC1234_study_guide_revised.pdf.docx").key).toBe("m 4 abc 1234 study guide");
    expect(versionKey("M3_2_ABC1234_F25_Doe.pdf").key).not.toBe(versionKey("M2_3_ABC1234_F25_Doe.pdf").key);
    expect(versionKey("Week 3-2.pdf").key).not.toBe(versionKey("Week 3.pdf").key);
  });

  it("groups plain, revised and accessible into one item: PDF first, then revised, then plain, then accessible", () => {
    const out = groupVersions([
      item(10, "M2_3_ABC1234_F25_Doe.pptx"),
      item(11, "M2_3_ABC1234_f25_Doe_revised.pptx", { foundIn: [{ kind: "module", moduleId: 5, moduleName: "Module 2" }] }),
      item(12, "M2_3_ABC1234_F25_Doe_accessible.pdf", { mergedFileIds: [99] }),
      item(13, "M2_3_ABC1234_F25_Doe_transcript.pdf"),
      item(14, "M2_4_ABC1234_F25_Doe_accessible.pdf"),
    ]);
    expect(out.map((i) => [i.fileId, i.role, i.versions])).toEqual([
      [12, "lecture", [12, 11, 10]],
      [13, "transcript", []],
      [14, "lecture", []],
    ]);
    expect(out[0].foundIn).toEqual([{ kind: "files" }, { kind: "module", moduleId: 5, moduleName: "Module 2" }]);
    expect(out[0].mergedFileIds).toEqual([99]);
    // Among non-PDFs, revised beats plain; among PDFs, plain beats accessible.
    expect(groupVersions([item(1, "Deck_accessible.pptx"), item(2, "Deck.pptx"), item(3, "Deck_revised.pptx")])[0].versions).toEqual([3, 2, 1]);
    expect(groupVersions([item(1, "Deck_accessible.pdf"), item(2, "Deck.pdf")])[0].versions).toEqual([2, 1]);
  });

  it("a plain version the rules can't place takes its sibling's role", () => {
    const out = groupVersions([item(1, "Sprockets.pdf"), item(2, "Sprockets_revised.pptx")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fileId: 1, name: "Sprockets.pdf", role: "lecture", versions: [1, 2] });
    expect(out[0].roleReason).toBe("filename matches slide version (accessible or revised)");
  });

  it("normalizeCourse sets versions on every item", () => {
    const out = normalizeCourse(load("files-layout.course.json"));
    expect(out.items.every((i) => Array.isArray(i.versions))).toBe(true);
  });
});
