// The chips under an Ask answer, built in the browser from the claims the server already checked: each claim's quote
// is found again, word for word, in the passage it cites (or, for a saved reply, any passage this turn's search
// returned), and becomes a lecture chip (its line's second, the lecture's date and the course colour) or a slide or
// page chip. Then the PR #3 rules, for every question card still unanswered in the chat and every graded question:
// no poll or answer slide, no chip whose quote gives the answer away, and never the moment that explains the answer
// (a lecture chip inside the question's clip, from its example's start to its end, in the same lecture) or the
// question's own slide.

import type { SeedQuestion } from "../demo/types.ts";
import { chipKey, dedupeChips } from "../tutor/chips.ts";
import { found, groundClaims, type Grounded } from "../tutor/claims.ts";
import { revealsAnswer } from "../tutor/integrity.ts";
import { isAnswerSlide } from "../tutor/poll.ts";
import type { SearchHit } from "./search.ts";
import type { AskCourse } from "./types.ts";

export interface AskChip {
  grounded: Grounded;
  courseId: string;
  /** For a lecture chip: the lecture's date and the course's tape shell. */
  moment: { date: string | null; shell: 1 | 2 | 3 | 4 } | null;
  /** The lecture it is in (for the clip tile). */
  lecture?: string;
  /** A practice card's rewind chip: its question (its slide is the tile's poster, its hosted clip plays). */
  questionId?: string;
}

const textOf = (h: SearchHit) => (h.passage.kind === "lecture" ? h.passage.lines.map((l) => l.text).join(" ") : h.passage.text);

/** The lecture date a question's clip is in (its course's chip moments). */
const dateOf = (q: SeedQuestion, courses: AskCourse[]) => courses.find((c) => c.bank?.seed.questions.some((x) => x.id === q.id))?.bank?.moments[q.id]?.date ?? null;

/** Is this chip the question's own evidence: the moment that explains its answer, or its own slide? */
export function explains(g: Grounded, chipDate: string | null, q: SeedQuestion, courses: AskCourse[]): boolean {
  if (g.kind === "slide") return g.deck === q.match.slide.deck && g.page === q.match.slide.page;
  const m = q.match as { start: number | null; end: number | null; exampleStart?: number | null };
  if (typeof m.start !== "number" || typeof m.end !== "number") return false;
  const qDate = dateOf(q, courses);
  // Unknown dates on either side: same second range counts (it may be the same lecture).
  if (qDate && chipDate && qDate !== chipDate) return false;
  const from = Math.min(m.start, m.exampleStart ?? m.start);
  return g.start >= from - 1 && g.start <= m.end + 1;
}

export function chipsFor(
  claims: { quote: string; source?: string }[],
  hits: SearchHit[],
  courses: AskCourse[],
  guard: { open: SeedQuestion[]; graded: SeedQuestion[] },
): AskChip[] {
  const out: AskChip[] = [];
  for (const c of claims) {
    const hit = hits.find((h) => h.id === c.source && found(textOf(h), c.quote)) ?? hits.find((h) => found(textOf(h), c.quote));
    if (!hit) continue;
    const p = hit.passage;
    const course = courses.find((x) => x.id === hit.courseId);
    const [g] =
      p.kind === "lecture"
        ? groundClaims([{ quote: c.quote }], { lecture: p.lines, slide: null })
        : groundClaims([{ quote: c.quote }], { lecture: [], slide: { quote: p.text, deck: p.kind === "slide" ? p.deck : p.title, page: p.kind === "slide" ? p.page : 0, kind: p.kind === "slide" ? p.pageKind : "page" } });
    if (!g) continue;
    if (g.kind === "slide" && isAnswerSlide({}, p.kind === "lecture" ? "" : p.text)) continue;
    const guarded = [...guard.open, ...guard.graded];
    if (guarded.some((q) => revealsAnswer(c.quote, q))) continue;
    if (guarded.some((q) => explains(g, p.kind === "lecture" ? p.date : null, q, courses))) continue;
    const href = p.kind === "lecture" ? undefined : (p.href ?? undefined);
    const grounded: Grounded = g.kind === "slide" ? { ...g, ...(href ? { href } : {}) } : g;
    out.push({ grounded, courseId: hit.courseId, moment: p.kind === "lecture" ? { date: p.date, shell: course?.shell ?? 1 } : null, ...(p.kind === "lecture" ? { lecture: p.lecture } : {}) });
  }
  return dedupeChips(out, (c) => chipKey(c.grounded, c.lecture));
}
