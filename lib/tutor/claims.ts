// Every claim the tutor shows from the course carries a word-for-word quote from the course material,
// checked here with quoteIn (lib/pipeline/exams.ts) and linked to its moment: a lecture line → the clip,
// a slide quote → the slide. A claim that can't be found is dropped, and the reply is shown without
// "From your course".

import { quoteIn } from "../pipeline/exams.ts";

export interface Material {
  /** Lecturer lines (start in seconds). */
  lecture: { start: number; text: string }[];
  /** The slide (or page) the question's own quote is from. */
  slide: { quote: string; deck: string; page: number; kind: "slide" | "page"; revealsAnswer?: boolean } | null;
}

export type Grounded =
  | { kind: "lecture"; quote: string; start: number }
  | {
      kind: "slide";
      quote: string;
      deck: string;
      page: number;
      pageKind: "slide" | "page";
      /** Where the chip opens, when it isn't the question's own slide (an earlier slide standing in for a poll slide). */
      href?: string;
      /** A poll or answer slide (lib/tutor/poll.ts): never shown before the student answers. */
      revealsAnswer?: boolean;
    };

/** Too short to mean anything (a quoted "the" would be "found" everywhere). */
const MIN_WORDS = 5;
const MIN_CHARS = 20;

const ws = (t: string) => t.replace(/\s+/g, " ").trim();
/** quoteIn, and the quote starts and ends on word boundaries: "the root" is not found inside "the rooted tree". */
export function found(text: string, quote: string): boolean {
  if (!quoteIn(text, quote)) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${ws(quote).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
  return re.test(ws(text));
}

export function groundClaims(claims: { quote: string }[], m: Material): Grounded[] {
  const out: Grounded[] = [];
  const seen = new Set<string>();
  for (const { quote: raw } of claims) {
    const quote = typeof raw === "string" ? raw.trim() : "";
    if (quote.length < MIN_CHARS || quote.split(/\s+/).length < MIN_WORDS) continue;
    let hit: Grounded | null = null;
    for (let i = 0; i < m.lecture.length && !hit; i++) {
      const line = m.lecture[i];
      // One line, or a quote that runs into the next line.
      if (found(line.text, quote) || (m.lecture[i + 1] && found(`${line.text} ${m.lecture[i + 1].text}`, quote) && !found(m.lecture[i + 1].text, quote))) {
        hit = { kind: "lecture", quote, start: line.start };
      }
    }
    if (!hit && m.slide && found(m.slide.quote, quote)) hit = { kind: "slide", quote, deck: m.slide.deck, page: m.slide.page, pageKind: m.slide.kind, ...(m.slide.revealsAnswer ? { revealsAnswer: true } : {}) };
    if (!hit) continue;
    const key = hit.kind === "lecture" ? `l${hit.start}` : `s${hit.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
