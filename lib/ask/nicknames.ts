// What a student calls a course: "DSA" for COP3530 Data Structures and Algorithms, "lin alg" for MAS3114, the
// professor's name. Derived from the code and title in code (never guessed by the model), and resolved here.

const SMALL = new Set(["and", "of", "the", "for", "in", "to", "a", "an", "with", "&", "i", "ii", "iii", "intro"]);
/** Common short forms of title words. */
const SHORT: Record<string, string[]> = {
  algorithms: ["algo", "algos"],
  linear: ["lin"],
  algebra: ["alg"],
  calculus: ["calc"],
  computational: ["comp"],
  programming: ["prog"],
  introduction: ["intro"],
  statistics: ["stats", "stat"],
  physics: ["phys"],
  chemistry: ["chem"],
  differential: ["diff"],
  equations: ["eq", "eqs"],
  discrete: ["disc"],
  mathematics: ["math"],
  structures: ["struct"],
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]+/g, " ").split(/\s+/).filter(Boolean);
export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Canvas names often carry the code and term ("COP3530 - Fa26"); the title is what's left. */
export function cleanTitle(title: string, code: string): string {
  return title
    .replace(new RegExp(normName(code).replace(/(\d)/, "\\s*$1"), "i"), "")
    .replace(/\b(?:fa|sp|su|fall|spring|summer)\s*'?\d{2,4}\b/gi, "")
    .replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, "")
    .trim();
}

/** The nicknames for a course, lower case: the code, its letters and number, the title, its initials and short forms. */
export function nicknamesOf(code: string, title: string, lecturer?: string | null): string[] {
  const out = new Set<string>();
  const c = normName(code);
  out.add(c);
  const m = c.match(/^([a-z]+)(\d+)/);
  if (m) {
    out.add(m[1]);
    out.add(m[2]);
  }
  const t = cleanTitle(title, code);
  const w = words(t);
  if (w.length) {
    out.add(w.join(" "));
    const big = w.filter((x) => !SMALL.has(x));
    if (big.length >= 2) {
      out.add(big.map((x) => x[0]).join(""));
      // "Data Structures and Algorithms" → "data structures"; "Computational Linear Algebra" → "linear algebra".
      out.add(big.slice(0, 2).join(" "));
      out.add(big.slice(-2).join(" "));
      const short = big.slice(-2).map((x) => SHORT[x]?.[0] ?? x);
      out.add(short.join(" "));
      out.add(short.join(""));
    }
    for (const x of big) for (const s of SHORT[x] ?? []) if (big.length === 1) out.add(s);
    if (big.length === 1) out.add(big[0]);
  }
  if (lecturer) {
    const last = words(lecturer).filter((x) => !["professor", "prof", "dr", "mr", "ms", "mrs"].includes(x)).pop();
    if (last) out.add(last);
  }
  return [...out].filter((x) => x.length >= 2);
}

export type Resolved<T> = { course: T } | { ambiguous: T[] } | { none: true };

/**
 * The course a name means: an exact code, nickname or title first, then a nickname or code inside the words
 * ("the DSA exam"), then the title's words. Two equally good matches are ambiguous: the model asks.
 */
export function resolveCourse<T extends { code: string; title: string; nicknames: string[] }>(name: string, courses: T[]): Resolved<T> {
  const q = name.trim().toLowerCase();
  if (!q) return { none: true };
  const n = normName(q);
  const exact = courses.filter((c) => normName(c.code) === n || c.nicknames.some((k) => normName(k) === n) || normName(cleanTitle(c.title, c.code)) === n);
  if (exact.length === 1) return { course: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };
  const qw = words(q);
  const inside = courses.filter((c) => c.nicknames.some((k) => (k.includes(" ") ? q.includes(k) : qw.includes(k))));
  if (inside.length === 1) return { course: inside[0] };
  if (inside.length > 1) return { ambiguous: inside };
  const big = qw.filter((x) => !SMALL.has(x) && x.length >= 4);
  const score = (c: T) => big.filter((x) => words(c.title).some((t) => t.startsWith(x) || x.startsWith(t))).length;
  const best = Math.max(0, ...courses.map(score));
  if (!best) return { none: true };
  const top = courses.filter((c) => score(c) === best);
  return top.length === 1 ? { course: top[0] } : { ambiguous: top };
}
