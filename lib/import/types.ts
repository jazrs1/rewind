// Local types for the Canvas import. CourseExport matches the `*.course.json` format
// written by the extension (AGENT_TASKS.md, "Course export JSON"); the lead reconciles
// these with lib/schema.ts.

/** A failed Canvas endpoint, recorded instead of stopping the export. */
export interface ExportError {
  endpoint: string;
  /** null for a network failure. */
  status: number | null;
}

/** Raw Canvas file object. Only the fields read here are typed. */
export interface CanvasFile {
  id: number;
  display_name?: string;
  filename?: string;
  "content-type"?: string;
  size?: number;
  url?: string;
  folder_id?: number;
  [key: string]: unknown;
}

/** Raw module item (from `include[]=items`). */
export interface CanvasModuleItem {
  id: number;
  title?: string;
  type?: string;
  /** For type "File", the file ID. */
  content_id?: number;
  /** For type "Page", the page slug. */
  page_url?: string;
  [key: string]: unknown;
}

export interface CanvasModule {
  id: number;
  name?: string;
  items?: CanvasModuleItem[];
  [key: string]: unknown;
}

export interface CanvasPage {
  url: string;
  title?: string;
  body?: string | null;
  [key: string]: unknown;
}

export type CanvasObject = Record<string, unknown>;

/** `*.course.json`, written by the Canvas exporter. Arrays hold raw Canvas objects. */
export interface CourseExport {
  exportedAt: string;
  course: { id: number; name: string | null; course_code: string | null };
  files: CanvasFile[];
  modules: CanvasModule[];
  pages: CanvasPage[];
  assignments: CanvasObject[];
  announcements: CanvasObject[];
  submissions: CanvasObject[];
  syllabus_body: string | null;
  errors: ExportError[];
}

/**
 * Role from the rules, then the Flash-Lite classifier for what the rules leave "unknown"
 * (`classifyUnknowns` in classify.ts). A subset of `ItemRole` in lib/schema.ts.
 */
export type ImportRole = "lecture" | "transcript" | "review" | "practice" | "syllabus" | "admin" | "unknown";

export const IMPORT_ROLES: readonly ImportRole[] = ["lecture", "transcript", "review", "practice", "syllabus", "admin", "unknown"];

/** Where a file was found. */
export type FoundIn =
  | { kind: "files" }
  | { kind: "module"; moduleId: number; moduleName: string | null }
  | { kind: "page"; pageUrl: string; pageTitle: string | null; moduleId: number | null; moduleName: string | null };

export interface ImportItem {
  fileId: number;
  name: string;
  /** Null when the file is known only from a module item or page link. */
  contentType: string | null;
  size: number | null;
  /** Canvas link to the file. */
  url: string;
  role: ImportRole;
  /**
   * Which rule set the role, e.g. `filename matches review or past exam`, or
   * `classifier: <one-line reason>` when Flash-Lite set it; null for "unknown".
   */
  roleReason: string | null;
  foundIn: FoundIn[];
  /** File IDs merged into this item (name + size duplicates, or the PPTX of a PDF deck). */
  mergedFileIds: number[];
  /**
   * Versions of the same document (`..._revised`, `..._accessible`, plain, other formats), as
   * file IDs, best first (PDF, then "revised", then plain, then "accessible"); this item is
   * the best one, so `versions[0] === fileId`. Empty when there is only one version.
   * Always set by `normalizeCourse`; optional so hand-built items stay valid.
   */
  versions?: number[];
}

export interface SkippedFile {
  fileId: number;
  name: string;
  reason: "image";
}

export interface NormalizedCourse {
  courseId: number;
  items: ImportItem[];
  skipped: SkippedFile[];
}
