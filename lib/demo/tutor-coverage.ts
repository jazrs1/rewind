// Does public/demo/course/tutor.json (the saved replies) cover every demo question? A question without an entry plays the
// generic "the live tutor is busy" line when the live tutor is capped or down. Used by a unit test and by a warning at
// build and dev-server start (next.config.ts). Pure: it takes the two parsed files.

const KINDS = ["hint1", "hint2", "socratic", "confirm", "answer"] as const;

export interface CoverageGaps {
  /** Demo question ids with no entry, or an entry missing a reply. */
  missing: string[];
  /** Entries for ids that aren't demo questions any more. */
  extra: string[];
}

export function demoQuestionIds(bundleRaw: unknown): string[] {
  const sets = (bundleRaw as { sets?: { questions?: { id?: unknown }[] }[] } | null)?.sets ?? [];
  return sets.flatMap((s) => (s.questions ?? []).map((q) => q.id)).filter((id): id is string => typeof id === "string");
}

export function coverageGaps(bundleRaw: unknown, savedRaw: unknown): CoverageGaps {
  const ids = demoQuestionIds(bundleRaw);
  const entries = (savedRaw as { questions?: Record<string, Record<string, { text?: unknown } | undefined> | undefined> } | null)?.questions ?? {};
  const complete = (id: string) => KINDS.every((k) => typeof entries[id]?.[k]?.text === "string" && (entries[id]![k]!.text as string).trim() !== "");
  return { missing: ids.filter((id) => !complete(id)), extra: Object.keys(entries).filter((id) => !ids.includes(id)) };
}

/** One warning line for the console, or null when the file is sound. `saved` null = the file isn't there. */
export function coverageWarning(bundleRaw: unknown, savedRaw: unknown | null): string | null {
  const total = demoQuestionIds(bundleRaw).length;
  if (savedRaw === null) {
    return `public/demo/course/tutor.json is missing: the demo's saved tutor replies play a generic line for all ${total} questions. Run scripts/demo/precompute-tutor.ts.`;
  }
  const { missing } = coverageGaps(bundleRaw, savedRaw);
  return missing.length ? `public/demo/course/tutor.json doesn't cover ${missing.length} of ${total} demo questions (first: ${missing[0]}). Run scripts/demo/precompute-tutor.ts again.` : null;
}

/** Demo questions with no saved similar question (they say so plainly when the live tutor can't make one). */
export function similarGaps(bundleRaw: unknown, savedRaw: unknown): string[] {
  const entries = (savedRaw as { questions?: Record<string, { similar?: unknown[] } | undefined> } | null)?.questions ?? {};
  return demoQuestionIds(bundleRaw).filter((id) => !(Array.isArray(entries[id]?.similar) && entries[id]!.similar!.length));
}

/** One warning line when saved similar questions are missing (a file made before they existed), else null. */
export function similarWarning(bundleRaw: unknown, savedRaw: unknown | null): string | null {
  if (savedRaw === null) return null;
  const gaps = similarGaps(bundleRaw, savedRaw);
  return gaps.length ? `public/demo/course/tutor.json has no saved similar question for ${gaps.length} of ${demoQuestionIds(bundleRaw).length} demo questions. Run scripts/demo/precompute-tutor.ts again.` : null;
}
