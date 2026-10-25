import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_SCHEMA,
  CLASSIFIER_SYSTEM,
  classifierPrompt,
  classifyUnknowns,
  cleanAnswer,
  flashLiteClassifier,
  type ClassifierInput,
  type RoleClassifier,
} from "./classify";
import type { ImportItem, NormalizedCourse } from "./types";

// Invented names only. No Gemini: the classifier is always a fake.

function item(fileId: number, name: string, role: ImportItem["role"], extra: Partial<ImportItem> = {}): ImportItem {
  return {
    fileId,
    name,
    contentType: "application/pdf",
    size: 1,
    url: `/courses/1/files/${fileId}`,
    role,
    roleReason: role === "unknown" ? null : "filename matches lecture or slides",
    foundIn: [{ kind: "files" }],
    mergedFileIds: [],
    versions: [],
    ...extra,
  };
}

const course: NormalizedCourse = {
  courseId: 1,
  skipped: [],
  items: [
    item(1, "Lecture 1.pdf", "lecture"),
    item(2, "Widget Primer.pdf", "unknown", {
      foundIn: [
        { kind: "files" },
        { kind: "module", moduleId: 7, moduleName: "TOOLS" },
        { kind: "page", pageUrl: "tools", pageTitle: "Tool help", moduleId: 7, moduleName: "TOOLS" },
      ],
    }),
    item(3, "mystery.bin", "unknown"),
    item(4, "Gadget access guide.pdf", "unknown"),
    item(5, "odd.pdf", "unknown"),
  ],
};

describe("classifyUnknowns", () => {
  it("asks only about unknown items, with module names, page titles and course name", async () => {
    const seen: ClassifierInput[] = [];
    const fake: RoleClassifier = async (input) => {
      seen.push(input);
      if (input.name === "Widget Primer.pdf") return { role: "practice", reason: "a tutorial in the TOOLS module" };
      if (input.name === "Gadget access guide.pdf") return { role: "admin", reason: "how to access software" };
      if (input.name === "odd.pdf") throw new Error("quota");
      return { role: "unknown", reason: "nothing to go on" };
    };
    const out = await classifyUnknowns(course, fake, { courseName: "Fake Course" });
    expect(seen.map((s) => s.name)).toEqual(["Widget Primer.pdf", "mystery.bin", "Gadget access guide.pdf", "odd.pdf"]);
    expect(seen[0]).toEqual({
      courseName: "Fake Course",
      name: "Widget Primer.pdf",
      moduleNames: ["TOOLS"],
      pageTitles: ["Tool help"],
      firstPageText: null,
    });
    expect(out.items.map((i) => [i.fileId, i.role, i.roleReason])).toEqual([
      [1, "lecture", "filename matches lecture or slides"],
      [2, "practice", "classifier: a tutorial in the TOOLS module"],
      [3, "unknown", null],
      [4, "admin", "classifier: how to access software"],
      [5, "unknown", null],
    ]);
    expect(out.classifier).toEqual({ asked: 4, placed: 2, stillUnknown: 1, failed: 1 });
    // Everything else about the items is unchanged.
    expect(out.items[1].foundIn).toEqual(course.items[1].foundIn);
  });

  it("passes the first page's text when the caller has it, collapsed and capped", async () => {
    const seen: ClassifierInput[] = [];
    await classifyUnknowns({ ...course, items: [course.items[1]] }, async (i) => (seen.push(i), { role: "unknown", reason: "" }), {
      firstPageText: () => "Widget\n\n  primer " + "x".repeat(3000),
    });
    expect(seen[0].firstPageText?.startsWith("Widget primer x")).toBe(true);
    expect(seen[0].firstPageText).toHaveLength(1500);
  });

  it("a role outside the list stays unknown", async () => {
    const out = await classifyUnknowns(course, async () => ({ role: "homework" as never, reason: "x" }));
    expect(out.items.filter((i) => i.role === "unknown")).toHaveLength(4);
    expect(out.classifier.stillUnknown).toBe(4);
  });
});

describe("cleanAnswer", () => {
  it("restricts the role and trims the reason to one line", () => {
    expect(cleanAnswer({ role: "review", reason: " past exam\n with answers " })).toEqual({ role: "review", reason: "past exam with answers" });
    expect(cleanAnswer({ role: "quiz", reason: "x" }).role).toBe("unknown");
    expect(cleanAnswer(null)).toEqual({ role: "unknown", reason: "" });
  });
});

describe("flashLiteClassifier", () => {
  it("sends the prompt, the role-restricted schema and the system text to the given model", async () => {
    const calls: unknown[][] = [];
    const fakeGenerate = async (...args: unknown[]) => {
      calls.push(args);
      return { role: "transcript", reason: "the name says transcript" };
    };
    const classify = flashLiteClassifier(fakeGenerate, "fake-lite");
    const input: ClassifierInput = { courseName: "Fake", name: "Notes A.pdf", moduleNames: [], pageTitles: [], firstPageText: null };
    expect(await classify(input)).toEqual({ role: "transcript", reason: "the name says transcript" });
    expect(calls).toEqual([["fake-lite", classifierPrompt(input), CLASSIFIER_SCHEMA, { system: CLASSIFIER_SYSTEM, temperature: 0 }]]);
    expect(CLASSIFIER_SCHEMA.properties.role.enum).toEqual(["lecture", "transcript", "review", "practice", "syllabus", "admin", "unknown"]);
    expect(classifierPrompt(input)).toContain("File name: Notes A.pdf");
    expect(classifierPrompt(input)).toContain("First page text: (not available)");
  });
});
