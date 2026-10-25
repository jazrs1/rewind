// Formats seconds as m:ss, or h:mm:ss past an hour (the tape counter's format).
export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "COP3530 Data Structures"; a Canvas name that already starts with the code ("COP3530 - Fa26") isn't repeated. */
export function courseTitle(c: { code: string; name: string }): string {
  const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();
  return !c.name ? c.code : squash(c.name).startsWith(squash(c.code)) ? c.name : `${c.code} ${c.name}`;
}

/**
 * A deck's file name as a display title: drops the leading number ("7 - ", "8a - "), splits
 * CamelCase ("HashTables" → "Hash Tables") and joins the last two items of a list with "&"
 * ("Sets, Maps, Hash Tables" → "Sets, Maps & Hash Tables"; an "and" already there is replaced,
 * never doubled). Underscores in file names are spaces ("COP3530_Syllabus_Fa26" → "COP3530 Syllabus Fa26").
 */
export function deckDisplayName(deck: string): string {
  const name = deck
    .replace(/\.(pdf|pptx?|docx?)$/i, "")
    .replace(/_+/g, " ")
    .replace(/^\s*\d+[a-z]?\s*[-–]\s*/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  const parts = name.split(/\s*,\s*/).filter(Boolean);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1].replace(/^(and|&)\s+/i, "");
  return `${parts.slice(0, -1).join(", ")} & ${last}`;
}

/** Ordinary words that start a sentence-case answer; only these are lowercased mid-sentence. */
const COMMON_START = new Set(
  "a an the both each every all any some no none one two three it its they their this that these those there he she we you "
    .concat("only always never not when if after before by in on at for with from to as of into onto over under between ")
    .concat("insert inserting remove removing add adding delete deleting find finding swap swapping return returns use using ")
    .concat("left right first last next previous new old same nothing everything nodes node keys key values value")
    .split(/\s+/),
);

/**
 * An answer as it reads inside a sentence ("You marked A, the new key overwrites the old one"): a capital first
 * letter is lowercased only when the first word is an ordinary word, so names (Dijkstra, AVL), code
 * (mergeSort(...)) and numbers stay as written.
 */
export function inSentence(text: string): string {
  const m = text.match(/^([A-Z][a-z']*)(\b[\s\S]*)$/);
  if (!m || !COMMON_START.has(m[1].toLowerCase().replace(/'.*$/, ""))) return text;
  // "A is adjacent to C", "A, B and C", "A → B": a lone capital that a verb, a list or an arrow follows is a name (a
  // vertex, a variable), never the article ("A new leaf").
  if (m[1].length === 1 && /^\s*(?:is|are|was|were|has|have|and|or|[,→=<>()-])/.test(m[2])) return text;
  return m[1].toLowerCase() + m[2];
}
