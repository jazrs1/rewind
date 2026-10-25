// A lecture's short topic label for the demo's tabs and headers ("Sorting · Oct 13", John, Oct 24): from the title of
// the lecture deck its questions come from (never a Discussion deck), its number dropped ("6 - Sorting" → "Sorting"),
// at most 14 characters. Deck titles that don't shorten well have a committed override.

export const LABEL_MAX = 14;

/** Deck title (number dropped) → its short label, where the title alone won't do. */
export const LABEL_OVERRIDES: Record<string, string> = {
  "Sets, Maps, HashTables": "Hash tables",
  "Graph Terminology and Implementation": "Graphs",
};

/** "6 - Sorting" → "Sorting"; "8a - Graph Terminology and Implementation" → "Graph Terminology and Implementation". */
export const deckTopic = (deck: string) => deck.replace(/^\s*[\w.]+\s+-\s+/, "").trim();

const isDiscussion = (deck: string) => /^\s*discussion\b/i.test(deck);

/** The lecture deck most of these questions come from (Discussion decks never count), or null. */
export function lectureDeck(decks: string[]): string | null {
  const counts = new Map<string, number>();
  for (const d of decks) if (d && !isDiscussion(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/** The short label: the override, else the topic itself when it fits, else its words up to 14 characters. */
export function shortLabel(deck: string): string {
  const topic = deckTopic(deck);
  const label = LABEL_OVERRIDES[topic] ?? topic;
  if (label.length <= LABEL_MAX) return label;
  let out = "";
  for (const w of label.split(/\s+/)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > LABEL_MAX) break;
    out = next;
  }
  return (out || label.slice(0, LABEL_MAX)).replace(/[,:;]$/, "");
}

/** A set's tab label and the full deck title under it (phone), from its questions' decks; null without a lecture deck. */
export function lectureLabel(decks: string[]): { topic: string; deck: string } | null {
  const deck = lectureDeck(decks);
  return deck ? { topic: shortLabel(deck), deck: deckTopic(deck) } : null;
}

/** "Lecture practice · Sorting · Oct 13": a lecture set's title on its practice sheet (the date alone without a topic). */
export function practiceTitle(lecture: string, decks: string[]): string {
  const date = lecture.replace(/^Lecture,\s*/, "");
  const l = lectureLabel(decks);
  return ["Lecture practice", l?.topic, date].filter(Boolean).join(" · ");
}
