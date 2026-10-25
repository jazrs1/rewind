// Checks a saved-replies file against the demo bundle (the types and the picker are in tutor-pick.ts).

import type { SavedFile } from "./tutor-pick.ts";
import { SAVED_FORMAT } from "./tutor-pick.ts";
import { found } from "../tutor/claims.ts";
import type { DemoBundle } from "./bundle.ts";
import { checkSimilar } from "../tutor/similar.ts";
import { safeChips } from "../tutor/poll.ts";
import type { SeedQuestion } from "./types.ts";

export * from "./tutor-pick.ts";

/**
 * The saved slots the page can play before the student has answered (a hint, a Socratic reply, the confirm), and the one
 * it plays only once an answer is marked (the answer). Their chips follow the live rule (lib/tutor/poll.ts safeChips).
 */
const BEFORE_ANSWER = ["hint1", "hint2", "socratic", "confirm"] as const;
const chipContext = (kind: string) => ({ answered: kind === "answer", graded: false, hint: kind.startsWith("hint") });

/**
 * The saved file with every chip the live rule wouldn't show taken out (the words stay), and every saved similar
 * question that no longer passes the live checks dropped (e.g. its source was the slide a re-pick replaced).
 */
export function sanitizeSaved(file: SavedFile, bundle: DemoBundle): SavedFile {
  const questions = new Map(bundle.sets.flatMap((s) => s.seed.questions.map((q) => [q.id, q] as const)));
  const out: SavedFile = { ...file, questions: {} };
  for (const [id, entry] of Object.entries(file.questions)) {
    const q = questions.get(id);
    if (!q) continue;
    const clean = { ...entry };
    for (const kind of [...BEFORE_ANSWER, "answer"] as const) {
      const r = entry[kind];
      if (r) clean[kind] = { ...r, grounded: safeChips(r.grounded ?? [], q, chipContext(kind)) };
    }
    if (entry.similar) clean.similar = entry.similar.filter((card) => !("problem" in checkSimilar({ ...card, code: card?.code?.lines ?? [], quote: card?.source?.quote }, q)));
    out.questions[id] = clean;
  }
  return out;
}

/** Saved chips the live rule wouldn't show: a reason per chip, empty when the entry is sound. */
function unsafeChips(id: string, entry: SavedFile["questions"][string], q: SeedQuestion): string[] {
  const errors: string[] = [];
  for (const kind of [...BEFORE_ANSWER, "answer"] as const) {
    const g = entry?.[kind]?.grounded ?? [];
    const ok = safeChips(g, q, chipContext(kind));
    for (const x of g) if (!ok.includes(x)) errors.push(`${id}.${kind}: a chip not allowed ${kind === "answer" ? "" : "before the student answers "}("${x.quote.slice(0, 30)}")`);
  }
  return errors;
}

/** What is wrong with a saved file against its bundle (empty when it is sound): every quote word for word in the course text. */
export function validateSaved(file: unknown, bundle: DemoBundle): string[] {
  const errors: string[] = [];
  const f = file as Partial<SavedFile> | null;
  if (!f || f.format !== SAVED_FORMAT || typeof f.questions !== "object" || !f.questions) return ["not a saved-replies file"];
  const questions = new Map(bundle.sets.flatMap((s) => s.seed.questions.map((q) => [q.id, q] as const)));
  for (const [id, entry] of Object.entries(f.questions)) {
    const q = questions.get(id);
    if (!q) {
      errors.push(`${id}: not a demo question`);
      continue;
    }
    for (const kind of ["hint1", "hint2", "socratic", "confirm", "answer"] as const) {
      const r = entry?.[kind];
      if (!r || typeof r.text !== "string" || !r.text.trim()) {
        errors.push(`${id}.${kind}: no text`);
        continue;
      }
      for (const g of r.grounded ?? []) {
        const lineHit = g.kind === "lecture" && q.segments.some((s) => s.start === g.start && found(s.text, g.quote));
        const slideHit = g.kind === "slide" && !!q.source && found(q.source.quote, g.quote);
        // A quote that runs over two lecture lines is anchored at the first.
        const span = g.kind === "lecture" && q.segments.some((s, i) => s.start === g.start && q.segments[i + 1] && found(`${s.text} ${q.segments[i + 1].text}`, g.quote));
        if (!lineHit && !slideHit && !span) errors.push(`${id}.${kind}: quote not found word for word: "${g.quote.slice(0, 40)}"`);
      }
    }
    errors.push(...unsafeChips(id, entry, q));
    // Saved similar questions pass the live checks again: shape, new values, a word-for-word source.
    for (const [i, card] of (entry?.similar ?? []).entries()) {
      const again = checkSimilar({ ...card, code: card?.code?.lines ?? [], quote: card?.source?.quote }, q);
      if ("problem" in again) errors.push(`${id}.similar[${i}]: ${again.problem}`);
    }
  }
  return errors;
}
