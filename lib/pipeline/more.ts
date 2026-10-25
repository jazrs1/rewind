// More questions on what each lecture taught (overnight item 18): for every lecture transcript, the
// decks it clearly teaches (retrieve.ts lectureForDeck), and among their pages the ones closest to
// what was said in that lecture, not yet used by an existing question. Each becomes one anchor, so
// the new questions are on that lecture's topic and their clips can come from it. Generation and
// retrieval then run as usual (scripts/pipeline/more.ts). Pure apart from the index it's given.

import { cosine } from "../rewind.ts";
import { groupName, isContent, MIN_ANCHOR_CHARS } from "./generate.ts";
import { deckLectureScores, lectureForDeck, type RetrieveIndex } from "./retrieve.ts";
import type { PipelineChunk, PracticeQuestion } from "./types.ts";

export interface LectureAnchor {
  /** The transcript (index.transcripts position) whose topic this anchor is on. */
  lecture: number;
  deck: string;
  anchor: PipelineChunk;
  /** The page's best similarity to the lecture's windows. */
  score: number;
}

const pageKey = (itemId: string, page: number) => `${itemId}#${page}`;

/** Pages existing questions already use: each one's quote page and shown slide, and the pages next to them. */
export function usedPages(questions: PracticeQuestion[]): Set<string> {
  const out = new Set<string>();
  for (const q of questions) {
    for (const s of [q.quoteSource, q.retrieval.slide]) {
      if (s && (s.kind === "slide" || s.kind === "document")) for (const d of [-1, 0, 1]) out.add(pageKey(s.itemId, s.page + d));
    }
  }
  return out;
}

/**
 * Up to `counts[lecture]` anchors per lecture: pages of the decks it teaches, best first, taken in
 * turn from each deck (so every taught deck gets some), never a used page or one next to a page
 * already picked.
 */
export function lectureAnchors(index: RetrieveIndex, chunks: PipelineChunk[], existing: PracticeQuestion[], counts: number[]): LectureAnchor[] {
  const used = usedPages(existing);
  const decks = [...new Set(chunks.filter((c) => isContent(c)).map(groupName))];
  const teaches = new Map<string, number | null>(decks.map((d) => [d, lectureForDeck(deckLectureScores(index, d))]));
  const vecOf = new Map(index.pages.map((p, i) => [p.chunk.id, index.pageVecs[i]]));
  const out: LectureAnchor[] = [];
  index.transcripts.forEach((_, t) => {
    const want = counts[t] ?? 0;
    if (!want) return;
    const ws = index.windows.flatMap((w, i) => (w.t === t ? [index.windowVecs[i]] : []));
    if (!ws.length) return;
    const byDeck = new Map<string, LectureAnchor[]>();
    for (const c of chunks) {
      if (!isContent(c) || c.text.trim().length < MIN_ANCHOR_CHARS) continue;
      const deck = groupName(c);
      if (teaches.get(deck) !== t) continue;
      const s = c.source as Extract<PipelineChunk["source"], { kind: "slide" | "document" }>;
      if (used.has(pageKey(s.itemId, s.page))) continue;
      const v = vecOf.get(c.id);
      if (!v) continue;
      const score = Math.max(...ws.map((w) => cosine(v, w)));
      byDeck.set(deck, [...(byDeck.get(deck) ?? []), { lecture: t, deck, anchor: c, score }]);
    }
    for (const list of byDeck.values()) list.sort((a, b) => b.score - a.score);
    const picked: LectureAnchor[] = [];
    const taken = new Set<string>();
    const order = [...byDeck.keys()].sort((a, b) => (byDeck.get(b)![0]?.score ?? 0) - (byDeck.get(a)![0]?.score ?? 0));
    while (picked.length < want && order.some((d) => byDeck.get(d)!.length)) {
      for (const d of order) {
        if (picked.length >= want) break;
        const list = byDeck.get(d)!;
        while (list.length) {
          const a = list.shift()!;
          const s = a.anchor.source as Extract<PipelineChunk["source"], { kind: "slide" | "document" }>;
          if ([-1, 0, 1].some((x) => taken.has(pageKey(s.itemId, s.page + x)))) continue;
          taken.add(pageKey(s.itemId, s.page));
          picked.push(a);
          break;
        }
      }
    }
    out.push(...picked);
  });
  return out;
}
