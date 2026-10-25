// The demo course's topics (pure; scripts/demo/demo-topics.json is the table, scripts/demo/export-demo.ts reads it).
// A question's topic comes from its slide's title, never from a model: the first table entry whose pattern matches
// the title wins; a slide with no text title is in the table's hand list. Topics are then merged, in the table's
// order, until there are at most `max`; fewer than `min` is an error.

export interface TopicTable {
  min: number;
  max: number;
  topics: { topic: string; patterns: string[] }[];
  untitled: { deck: string; page: number; topic: string; why: string }[];
  merges: { from: string[]; into: string }[];
}

/** How much of a slide's text is its title: its heading line and, on a poll slide, the poll's own question. */
export const TITLE_CHARS = 140;

/**
 * A slide's title text, or null when it has none: a slide whose text starts with a page number, a bullet or a link
 * had its title in an image (or no title), so its body text isn't taken for one.
 */
export function slideTitle(text: string | null): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  // "o " is a hollow bullet as the PDF text gives it.
  if (!/^\p{L}/u.test(t) || /^o\s/.test(t) || /^https?:/i.test(t)) return null;
  return t.slice(0, TITLE_CHARS);
}

/** A slide's topic and where it came from (its title, or the hand list), or null when neither has it. */
export function slideTopic(table: TopicTable, deck: string, page: number, text: string | null): { topic: string; from: "title" | "untitled" } | null {
  const title = slideTitle(text);
  if (title) for (const t of table.topics) if (t.patterns.some((p) => new RegExp(p, "i").test(title))) return { topic: t.topic, from: "title" };
  const hand = table.untitled.find((u) => u.deck === deck && u.page === page);
  return hand ? { topic: hand.topic, from: "untitled" } : null;
}

/**
 * Topic per question after the table's merges, applied in order while there are more than `max` distinct topics
 * (a topic is one name within one lecture). Throws when it ends outside min..max.
 */
export function mergeTopics(table: TopicTable, items: { id: string; lecture: string; topic: string }[]): Map<string, string> {
  const out = new Map(items.map((x) => [x.id, x.topic]));
  const count = () => new Set(items.map((x) => `${x.lecture}\u0000${out.get(x.id)}`)).size;
  for (const m of table.merges) {
    if (count() <= table.max) break;
    for (const x of items) if (m.from.includes(out.get(x.id)!)) out.set(x.id, m.into);
  }
  const n = count();
  // No questions at all is no bundle (parseBundle says so), not a topics problem.
  if (items.length && n < table.min || n > table.max) throw new Error(`The demo has ${n} topics after the table's merges; it needs ${table.min} to ${table.max} (scripts/demo/demo-topics.json)`);
  return out;
}
