// Quick build (beta): do the picked PDFs look like they're from the imported course? A course code ("COP3530",
// "MAP 2302") in a PDF's file name or on its first page that never matches the imported course's code means the
// student probably picked another course's folder: the build step asks before building from them.

import type { PdfFile } from "./pdf.ts";

/** "COP3530", "COP 3530", "COP-3530C": three capital letters, then four digits (and an optional letter), on word edges. */
const CODE = /\b([A-Z]{3})[\s-]?(\d{4})([A-Z]?)\b/g;

/** Every course code in a piece of text, as "COP3530" (the letter suffix dropped: a lab and its lecture are one course). */
export function codesIn(text: string): string[] {
  return [...text.matchAll(CODE)].map((m) => m[1] + m[2]);
}

/** The imported course's own code ("MAP2302-0123(12345)" -> "MAP2302"), or null if it has none in that form. */
export function courseCodeOf(code: string): string | null {
  return codesIn(code.toUpperCase())[0] ?? null;
}

export interface Mismatch {
  /** The code the PDFs carry (the most common one). */
  found: string;
  /** The imported course's code. */
  expected: string;
}

/**
 * A clear mismatch: the course has a code, at least one PDF names a course code, and none of the PDFs names the
 * course's own. A PDF with no code at all ("Week 3 Hashing.pdf") counts for nothing either way.
 */
export function courseMismatch(courseCode: string, pdfs: Pick<PdfFile, "deck" | "pages">[], fileNames: string[] = []): Mismatch | null {
  const expected = courseCodeOf(courseCode);
  if (!expected) return null;
  const counts = new Map<string, number>();
  const sources = [...pdfs.map((p) => `${p.deck}\n${p.pages[0]?.text ?? ""}`), ...fileNames];
  for (const s of sources) for (const c of new Set(codesIn(s))) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (!counts.size || counts.has(expected)) return null;
  const found = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return { found, expected };
}

/** The notice: "These files look like they're from COP3530, not MAP2302. Build anyway?" */
export const mismatchText = (m: Mismatch) => `These files look like they're from ${m.found}, not ${m.expected}. Build anyway?`;
