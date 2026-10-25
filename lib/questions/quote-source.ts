// Where a question's quote is, in the practice seed's short form (lib/demo/types.ts): a slide page
// or the lecture line it starts on. The pipeline itself cites with SourceRef (lib/pipeline/types.ts).

import { formatTime } from "../format.ts";
import type { SourceRef } from "../pipeline/types.ts";

export type QuoteSource = { kind: "slide"; deck: string; page: number } | { kind: "lecture"; start: number };

/** "slide 84 of 7 - Sets, Maps, HashTables" or "lecture 15:18". */
export function quoteSourceLabel(s: QuoteSource): string {
  return s.kind === "slide" ? `slide ${s.page} of ${s.deck}` : `lecture ${formatTime(s.start)}`;
}

/** The seed's form of a pipeline citation; null for kinds the seed has no form for. */
export function toQuoteSource(ref: SourceRef): QuoteSource | null {
  if (ref.kind === "slide") return { kind: "slide", deck: ref.deck, page: ref.page };
  if (ref.kind === "document") return { kind: "slide", deck: ref.name, page: ref.page };
  if (ref.kind === "lecture") return { kind: "lecture", start: ref.start };
  return null;
}
