// Second pass for what the rules leave "unknown": a cheap classifier (Flash-Lite through
// lib/gemini.ts, cached on disk) picks a role from the filename, the module names, the titles
// of the pages that link the file, and the first page's text when the caller has it.
// The classifier is injected, so tests pass a fake and never call Gemini.

import { IMPORT_ROLES, type ImportItem, type ImportRole, type NormalizedCourse } from "./types.ts";

export interface ClassifierInput {
  courseName: string | null;
  name: string;
  moduleNames: string[];
  pageTitles: string[];
  /** The file's first page as text; null when it isn't available (the export has no file contents). */
  firstPageText: string | null;
}

export interface ClassifierAnswer {
  role: ImportRole;
  reason: string;
}

export type RoleClassifier = (input: ClassifierInput) => Promise<ClassifierAnswer>;

export interface ClassifyOptions {
  courseName?: string | null;
  /** First page text for an item, if the caller can get it. */
  firstPageText?: (item: ImportItem) => Promise<string | null> | string | null;
}

export interface ClassifyResult extends NormalizedCourse {
  /** Items sent to the classifier, and how many it placed / left unknown / failed on. */
  classifier: { asked: number; placed: number; stillUnknown: number; failed: number };
}

const FIRST_PAGE_CHARS = 1500;

function inputFor(item: ImportItem, courseName: string | null, firstPageText: string | null): ClassifierInput {
  const moduleNames = new Set<string>();
  const pageTitles = new Set<string>();
  for (const f of item.foundIn) {
    if (f.kind !== "files" && f.moduleName) moduleNames.add(f.moduleName);
    if (f.kind === "page" && f.pageTitle) pageTitles.add(f.pageTitle);
  }
  return {
    courseName,
    name: item.name,
    moduleNames: [...moduleNames],
    pageTitles: [...pageTitles],
    firstPageText: firstPageText ? firstPageText.replace(/\s+/g, " ").trim().slice(0, FIRST_PAGE_CHARS) : null,
  };
}

/** Normalizes a classifier answer: a role outside the list, or a missing one, stays "unknown". */
export function cleanAnswer(raw: unknown): ClassifierAnswer {
  const a = (raw ?? {}) as { role?: unknown; reason?: unknown };
  const role = IMPORT_ROLES.includes(a.role as ImportRole) ? (a.role as ImportRole) : "unknown";
  const reason = typeof a.reason === "string" ? a.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { role, reason };
}

/**
 * Asks the classifier about every "unknown" item, one at a time (cached calls are free, and
 * the course has few unknowns left after the rules). Items it places get
 * `roleReason: "classifier: <reason>"`; a failure or an "unknown" answer leaves the item as is.
 */
export async function classifyUnknowns(
  course: NormalizedCourse,
  classify: RoleClassifier,
  opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
  const stats = { asked: 0, placed: 0, stillUnknown: 0, failed: 0 };
  const items: ImportItem[] = [];
  for (const item of course.items) {
    if (item.role !== "unknown") {
      items.push(item);
      continue;
    }
    stats.asked++;
    let answer: ClassifierAnswer;
    try {
      const text = opts.firstPageText ? await opts.firstPageText(item) : null;
      answer = cleanAnswer(await classify(inputFor(item, opts.courseName ?? null, text)));
    } catch {
      stats.failed++;
      items.push(item);
      continue;
    }
    if (answer.role === "unknown") {
      stats.stillUnknown++;
      items.push(item);
      continue;
    }
    stats.placed++;
    items.push({ ...item, role: answer.role, roleReason: `classifier: ${answer.reason || "no reason given"}` });
  }
  return { ...course, items, classifier: stats };
}

// ---------- the Flash-Lite classifier ----------

export const CLASSIFIER_SYSTEM = [
  "You sort a university course's files into roles for a study app.",
  "Roles:",
  "- lecture: slides or notes the instructor teaches from (a lesson, a deck, lecture notes).",
  "- transcript: a written transcript of a recorded lecture.",
  "- review: exam review material, a study guide, or a past exam and its answers.",
  "- practice: practice problems, discussion or recitation handouts, worksheets, labs, tutorials, assignment starter files.",
  "- syllabus: the course syllabus.",
  "- admin: logistics: schedules, policies, how to install or access software, contact info.",
  "- unknown: none of the above, or you can't tell from what's given.",
  "Answer with one role from that list and a one-line reason (under 20 words) that cites the evidence (name, module, page title or text).",
  "Don't guess: if the evidence doesn't point to a role, answer unknown.",
].join("\n");

export const CLASSIFIER_SCHEMA = {
  type: "object",
  properties: {
    role: { type: "string", enum: [...IMPORT_ROLES] },
    reason: { type: "string" },
  },
  required: ["role", "reason"],
};

export function classifierPrompt(input: ClassifierInput): string {
  const lines = [
    `Course: ${input.courseName ?? "(unknown)"}`,
    `File name: ${input.name}`,
    `Modules it appears in: ${input.moduleNames.length ? input.moduleNames.join("; ") : "(none)"}`,
    `Pages that link it: ${input.pageTitles.length ? input.pageTitles.join("; ") : "(none)"}`,
    `First page text: ${input.firstPageText ?? "(not available)"}`,
  ];
  return lines.join("\n");
}

/** The slice of lib/gemini.ts this needs, so tests can pass a fake. */
export type GenerateJSON = (
  model: string,
  prompt: string,
  schema: object,
  options?: { system?: string; temperature?: number },
) => Promise<unknown>;

/**
 * A RoleClassifier backed by Flash-Lite. Pass `generateJSON` and `MODELS.flashLite` from
 * lib/gemini.ts (cached by model + prompt + schema + options, so a rerun costs nothing).
 */
export function flashLiteClassifier(generateJSON: GenerateJSON, model: string): RoleClassifier {
  return async (input) =>
    cleanAnswer(
      await generateJSON(model, classifierPrompt(input), CLASSIFIER_SCHEMA, { system: CLASSIFIER_SYSTEM, temperature: 0 }),
    );
}
