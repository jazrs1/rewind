// Topic words and matching for the course tape. Pure, no Gemini: a topic is its title's
// content words (lightly stemmed), and a word shared by several topics counts less.

const STOP = new Set(
  (
    "a an and or the of to in on for with vs versus by from at as is are be into about " +
    "module modules week weeks unit chapter lesson part intro introduction overview basics basic " +
    "review exam exams quiz quizzes midterm final pdf pptx ppt slides slide lecture lectures notes " +
    "revised accessible discussion participation conceptual programming cq pq"
  ).split(" "),
);

/** Lowercase stem: tables→tabl, sorting→sort, hashes→hash, mapping→map, queues→queu. */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 4 && /(?:sh|ch|x|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith("ic")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w) && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

/** Stemmed words of a text, in order (camelCase split: "HashTables" → hash, tabl). */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w))
    .map(stem);
}

/** A topic's keywords: content words of its title, unique, in order. */
export function keywords(topic: string): string[] {
  return [...new Set(words(topic).filter((w) => !STOP.has(w) && w.length > 1))];
}

export interface TopicIndex {
  keys: string[];
  kw: Map<string, string[]>;
  /** Weight of a keyword: 1 / (number of topics that have it). */
  weight: (word: string) => number;
  /** Tape order of each key (lower = earlier), for tie-breaks. */
  rank: Map<string, number>;
}

export function topicIndex(topics: { key: string; topic: string }[]): TopicIndex {
  const kw = new Map(topics.map((t) => [t.key, keywords(t.topic)]));
  const df = new Map<string, number>();
  for (const ks of kw.values()) for (const k of ks) df.set(k, (df.get(k) ?? 0) + 1);
  return {
    keys: topics.map((t) => t.key),
    kw,
    weight: (w) => (df.has(w) ? 1 / df.get(w)! : 0),
    rank: new Map(topics.map((t, i) => [t.key, i])),
  };
}

/**
 * Topics a short text names (an assignment title, an announcement line, a file name): a topic
 * matches when the text holds at least half its keyword weight. A topic whose matched words are
 * a strict subset of another match's is dropped ("Balanced Trees" names Balanced Trees, not Trees).
 */
export function topicsIn(text: string, idx: TopicIndex): string[] {
  const have = new Set(words(text));
  const hits: { key: string; matched: Set<string> }[] = [];
  for (const key of idx.keys) {
    const ks = idx.kw.get(key)!;
    if (!ks.length) continue;
    const matched = ks.filter((k) => have.has(k));
    const total = ks.reduce((s, k) => s + idx.weight(k), 0);
    const got = matched.reduce((s, k) => s + idx.weight(k), 0);
    if (got > 0 && got >= total / 2 - 1e-9) hits.push({ key, matched: new Set(matched) });
  }
  return hits
    .filter((h) => !hits.some((o) => o !== h && o.matched.size > h.matched.size && [...h.matched].every((m) => o.matched.has(m))))
    .map((h) => h.key);
}

/** Weighted overlap of two titles' keywords (0..1): shared weight over combined weight. */
export function titleSimilarity(a: string, b: string, weight: (w: string) => number): number {
  const ka = new Set(keywords(a));
  const kb = new Set(keywords(b));
  const w = (k: string) => weight(k) || 1;
  let shared = 0;
  let all = 0;
  for (const k of new Set([...ka, ...kb])) {
    all += w(k);
    if (ka.has(k) && kb.has(k)) shared += w(k);
  }
  return all ? shared / all : 0;
}

/** Each topic's keyword weight in a stretch of lecture words (every occurrence counts). */
export function topicScores(text: string, idx: TopicIndex): Map<string, number> {
  const totals = new Map<string, number>();
  for (const w of words(text)) {
    const wt = idx.weight(w);
    if (!wt) continue;
    for (const key of idx.keys) if (idx.kw.get(key)!.includes(w)) totals.set(key, (totals.get(key) ?? 0) + wt);
  }
  return totals;
}

/**
 * The best topic in a score map if it reaches `min`. Ties go to the topic earlier on the tape
 * (a lecture covers the first of two same-named topics before the second).
 */
export function pickTopic(totals: Map<string, number>, idx: TopicIndex, min: number): { key: string; score: number } | null {
  let best: { key: string; score: number } | null = null;
  for (const [key, score] of totals) {
    if (
      !best ||
      score > best.score + 1e-9 ||
      (Math.abs(score - best.score) <= 1e-9 && idx.rank.get(key)! < idx.rank.get(best.key)!)
    )
      best = { key, score };
  }
  return best && best.score >= min - 1e-9 ? best : null;
}

/** The topic a stretch of lecture words is about, if its keyword weight reaches `min`. */
export function bestTopic(text: string, idx: TopicIndex, min: number): { key: string; score: number } | null {
  return pickTopic(topicScores(text, idx), idx, min);
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
}
