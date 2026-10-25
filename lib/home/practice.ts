// Which practice questions exist, per lecture and module, and what a /practice link selects (pure).
// The index is the one data swap when /practice moves from the local seed to the pipeline output:
// each question only needs an id, the lecture it's from (if any) and the module it's on (if known).
//   /practice?modules=9,10        the questions on those modules
//   /practice?lecture=2026-10-22  the questions from that lecture
// "Ready" anywhere on the home is computed from this index, never assumed.

import { lectureWords, modulesText, practicedLectures, readyModules, shortDate, stems, topicStems } from "./build.ts";
import type { HomeModuleInput, PracticeIndexQuestion } from "./types.ts";

export type { PracticeIndexQuestion };

/** The module a question is on: the one whose topic words its text (stem, slide deck, lecture lines) says most; null on none or a tie. */
export function questionModule(text: string, modules: HomeModuleInput[]): number | null {
  const counts = new Map<string, number>();
  for (const w of stems(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const scored = modules
    .map((m) => ({ position: m.position, score: m.topic ? topicStems(m.topic).reduce((a, w) => a + (counts.get(w) ?? 0), 0) : 0 }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0 || scored[1]?.score === scored[0].score) return null;
  return scored[0].position;
}

export interface PracticeSelection {
  /** Question ids to practise, in index order. */
  ids: string[];
  /** One line for the top of /practice: what's being practised and what isn't ready. */
  line: string;
}

/** Comma lists from the query: "9,10" → [9, 10]; dates stay strings. Invalid parts are dropped. */
export function parseModules(v: string | string[] | undefined): number[] | null {
  const s = Array.isArray(v) ? v.join(",") : v;
  if (!s) return null;
  const out = s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}
export function parseLectures(v: string | string[] | undefined): string[] | null {
  const s = Array.isArray(v) ? v.join(",") : v;
  if (!s) return null;
  const out = s.split(",").map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  return out.length ? [...new Set(out)].sort() : null;
}

/**
 * " · 6 with a clip: Oct 20 (3), Oct 22 (3)": every question that plays a clip, counted by its lecture
 * ("another lecture" when its date isn't known); "" when none does. A question without the `clip`
 * flag counts when it has a lecture (hand-written sets: every question has a clip).
 */
export function clipsText(picked: PracticeIndexQuestion[]): string {
  const clipped = picked.filter((x) => x.clip ?? x.lectureDate !== null);
  if (!clipped.length) return "";
  const by = new Map<string | null, number>();
  for (const x of clipped) by.set(x.lectureDate, (by.get(x.lectureDate) ?? 0) + 1);
  const parts = [...by]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([d, n]) => `${d ? shortDate(d) : "another lecture"} (${n})`);
  return ` · ${clipped.length} with a clip: ${parts.join(", ")}`;
}

/** What a /practice link selects. Null when the link selects nothing in particular (the whole set). */
export function practiceSelection(index: PracticeIndexQuestion[], q: { modules: number[] | null; lectures: string[] | null }): PracticeSelection | null {
  if (q.modules) {
    const ready = new Set(readyModules(index));
    const yes = q.modules.filter((m) => ready.has(m));
    const notYet = q.modules.filter((m) => !ready.has(m));
    if (!yes.length) return { ids: [], line: `No questions yet for ${modulesText(q.modules, "–")}.` };
    const picked = index.filter((x) => x.module !== null && yes.includes(x.module));
    return {
      ids: picked.map((x) => x.id),
      line: `${modulesText(yes, "–")} · ${picked.length} question${picked.length === 1 ? "" : "s"}${clipsText(picked)}${notYet.length ? ` · not yet: ${notYet.join(", ")}` : ""}`,
    };
  }
  if (q.lectures) {
    const have = new Set(practicedLectures(index));
    const yes = q.lectures.filter((d) => have.has(d));
    const none = q.lectures.filter((d) => !have.has(d));
    if (!yes.length) return { ids: [], line: `No questions yet for ${lectureWords(q.lectures)}.` };
    const picked = index.filter((x) => x.lectureDate !== null && yes.includes(x.lectureDate));
    const cap = lectureWords(yes);
    return {
      ids: picked.map((x) => x.id),
      line: `${cap[0].toUpperCase()}${cap.slice(1)} · ${picked.length} question${picked.length === 1 ? "" : "s"}${none.length ? ` · ${none.map(shortDate).join(", ")}: no questions yet` : ""}`,
    };
  }
  return null;
}


/** The questions a /practice link selects, numbered within the scoped set ("Question 2 of 5"); the whole set when `ids` is null. */
export function scopedSet<T extends { questions: { id: string; n: number }[] }>(seed: T, ids: string[] | null): T {
  if (!ids) return seed;
  const keep = new Set(ids);
  return { ...seed, questions: seed.questions.filter((q) => keep.has(q.id)).map((q, i) => ({ ...q, n: i + 1 })) };
}
