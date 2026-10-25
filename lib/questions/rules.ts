// Deterministic question-quality rules (John, Oct 23, from a real bug: the Oct 22 Q2 asked "what
// pair is returned for arr = [2, 7, 4, 9, 6], target = 13", which has two valid pairs, {2,3} and
// {1,4}, so it only worked because of an implementation detail; it said "the professor's solution"
// without showing it; and its options carried "because…" explanations).
//
// These run in code before the model's answer check (lib/prompts/answer-check.ts), so a question
// that breaks a rule is rejected without paying for a check, and the model is never trusted to
// count answers it could count wrong:
//   a. unique      exactly one defensible answer under the PROBLEM's definition (brute force here)
//   b. standalone  never refers to code, a solution or an example that isn't in the question
//   c. options     short and parallel: no "because…", similar length, none that gives itself away
//   d. style       sounds like the course's quizzes: never "the professor's…", length like theirs
// Pure functions, no I/O.

import type { ChoiceLabel } from "../schema.ts";

export type RuleId = "unique" | "standalone" | "options" | "style" | "quote" | "code" | "format" | "check";

export const RULE_NAMES: Record<RuleId, string> = {
  unique: "a. exactly one defensible answer",
  standalone: "b. nothing referenced that isn't shown",
  options: "c. short, parallel options",
  style: "d. course style",
  quote: "quote word for word and supporting",
  code: "code lines cited and 3-8 long",
  format: "complete question",
  check: "independent answer matches the key",
};

export interface RuleFailure {
  rule: RuleId;
  reason: string;
}

export interface CheckableQuestion {
  stem: string;
  code?: { language: string; lines: string[] } | null;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
}

const hasCode = (q: CheckableQuestion) => !!q.code && q.code.lines.some((l) => l.trim());

// ---------- b. standalone ----------

/** Words that name the course's people or sessions: a standalone question never mentions them. */
const ALWAYS_UNSEEN: { re: RegExp; what: string }[] = [
  { re: /\b(?:professor|instructor|lecturer|teacher)(?:'s|’s)?\b/i, what: "the professor" },
  { re: /\b(?:in|from|during|at) (?:the |today's |this |last )?(?:lecture|class|recitation|discussion section)\b/i, what: "something from lecture" },
  { re: /\blecture(?:'s|’s)\b/i, what: "something from lecture" },
  { re: /\b(?:the|this|that|on a|on the) slides?\b/i, what: "a slide" },
  { re: /\b(?:as )?(?:we|you) (?:saw|discussed|showed|covered|learned|did|wrote|traced)\b/i, what: "something seen earlier" },
  { re: /\bas (?:discussed|shown|seen|covered|presented|described) (?:earlier|before|previously|above|in)\b/i, what: "something seen earlier" },
  { re: /\b(?:above|earlier|previous|preceding|prior) (?:example|question|problem|figure|table|graph|diagram|tree|array|exercise)\b/i, what: "an example that isn't shown" },
  { re: /\b(?:example|question|problem|figure|table|diagram|exercise) (?:above|earlier|before|from before)\b/i, what: "an example that isn't shown" },
  { re: /\b(?:same|that) (?:example|problem|exercise) (?:as|from)\b/i, what: "an example that isn't shown" },
];

const CODE_NOUN = "(?:code|snippet|program|implementation|pseudocode|pseudo-code|solution|listing)";
/** "the professor's solution", "the unordered_map solution to two_sum", "the code": a definite reference to code. */
const CODE_REFERENCE = new RegExp(`\\b(?:the|this|that|his|her|our|their|given|above|following|below|shown)\\s+(?:(?!(?:is|are|was|were|be|a|an|of|best|correct|right|optimal|fastest)\\b)[\\w'’-]+\\s+){0,3}?${CODE_NOUN}\\b`, "i");

/**
 * Phrases that refer to something not on screen. With code shown in the question, "the code
 * shown" is fine; references to the professor, lecture, slides or an earlier example never are.
 */
export function unseenReferences(q: CheckableQuestion): string[] {
  const text = [q.stem, ...q.choices.map((c) => c.text)].join("\n");
  const found: string[] = [];
  for (const { re, what } of ALWAYS_UNSEEN) {
    const m = text.match(re);
    if (m) found.push(`"${m[0]}" (${what})`);
  }
  if (!hasCode(q)) {
    const m = text.match(CODE_REFERENCE);
    if (m) found.push(`"${m[0]}" (code or a solution that isn't shown)`);
  }
  return found;
}

// ---------- c. options ----------

const CONNECTIVES = /\b(?:because|since|due to|therefore|thus|hence|which means|meaning that|so that|as a result|this is why|that's why|that is why)\b/i;
const CATCH_ALL = /\b(?:all|none|both) of the (?:above|options|choices|these)\b|\bboth [A-D] and [A-D]\b/i;
const MAX_OPTION_WORDS = 14;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Options are short and parallel: no explanations, similar length, no giveaway, no catch-alls. */
export function optionProblems(q: CheckableQuestion): string[] {
  const out: string[] = [];
  for (const c of q.choices) {
    const m = c.text.match(CONNECTIVES);
    if (m) out.push(`option ${c.label} explains itself ("${m[0]}…"); options are answers, not reasons`);
    if (CATCH_ALL.test(c.text)) out.push(`option ${c.label} is a catch-all ("${c.text}")`);
    if (words(c.text) > MAX_OPTION_WORDS) out.push(`option ${c.label} is ${words(c.text)} words (at most ${MAX_OPTION_WORDS})`);
  }
  const lens = q.choices.map((c) => c.text.trim().length);
  const wc = q.choices.map((c) => words(c.text));
  const [minL, maxL] = [Math.min(...lens), Math.max(...lens)];
  const [minW, maxW] = [Math.min(...wc), Math.max(...wc)];
  if (maxL > 2.5 * minL + 12 || maxW > 2 * minW + 3) {
    const long = q.choices[lens.indexOf(maxL)].label;
    const short = q.choices[lens.indexOf(minL)].label;
    out.push(`options differ too much in length (${short}: ${minL} characters, ${long}: ${maxL})`);
  }
  // The keyed option stands out as the one long, careful answer.
  const key = q.choices.find((c) => c.label === q.answer);
  if (key) {
    const others = q.choices.filter((c) => c !== key).map((c) => c.text.trim().length);
    const next = Math.max(...others);
    const k = key.text.trim().length;
    if (k >= 1.5 * next && k - next >= 10) out.push(`the correct option is much longer than the others (${k} vs at most ${next} characters), which gives it away`);
  }
  return out;
}

// ---------- d. style ----------

/** The stem's length is in the range of the course's own questions (when there are examples). */
export function styleProblems(q: CheckableQuestion, styleExamples: string[]): string[] {
  const stems = styleExamples.map((e) => e.split(/\s*\(A\)\s/)[0]).filter((s) => s.trim());
  if (!stems.length) return [];
  const longest = Math.max(...stems.map(words));
  const limit = Math.max(40, Math.ceil(1.6 * longest));
  const n = words(q.stem);
  return n > limit ? [`the stem is ${n} words; the course's questions run to ${longest} (limit ${limit})`] : [];
}

// ---------- a. unique (brute force) ----------

export interface Enumeration {
  problem: string;
  /** Every answer that is valid under the problem's own definition. */
  answers: string[];
  /** How the input was read, for the rejection reason. */
  input: string;
}

/** The question shows code and asks what that code does or returns (then the code decides ties). */
export function asksAboutShownCode(q: CheckableQuestion): boolean {
  return hasCode(q) && /\b(?:this|the|above|below|following|given|shown)\s+(?:code|snippet|function|program|implementation|loop)\b/i.test(q.stem);
}

const NUM = "-?\\d+(?:\\.\\d+)?";

/** Two-sum style: "arr = [2, 7, 4, 9, 6], target = 13": every pair of positions whose values sum to the target. */
export function enumeratePairSums(stem: string): Enumeration | null {
  if (!/\b(?:pairs?|indices|indexes|two (?:numbers|elements|values|entries|integers|positions)|which two|two[-_ ]?sum)\b/i.test(stem)) return null;
  const arr = stem.match(new RegExp(`\\[\\s*(${NUM}(?:\\s*,\\s*${NUM})+)\\s*\\]`));
  const target = stem.match(new RegExp(`\\btarget(?:\\s+(?:sum|value))?\\s*(?:=|is|of|:)?\\s*(${NUM})\\b`, "i")) ?? stem.match(new RegExp(`\\b(?:sums?|adds? up|add)\\s+to\\s+(${NUM})\\b`, "i"));
  if (!arr || !target) return null;
  const a = arr[1].split(",").map((x) => Number(x.trim()));
  const t = Number(target[1]);
  const answers: string[] = [];
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (a[i] + a[j] === t) answers.push(`indices {${i}, ${j}} (${a[i]} + ${a[j]})`);
  return { problem: "pair sum", answers, input: `[${a.join(", ")}] with target ${t}` };
}

const TIE_BREAK = /\b(?:alphabetical|lexicographic|smallest|lowest|largest|increasing|ascending|descending|numerical order|in the order (?:they are |they're )?(?:listed|given)|adjacency list order|order of the adjacency)/i;

/** BFS/DFS visit orders on a small graph written in the stem ("edges A–B, A–C, B–D"), when no tie-break is stated. */
export function enumerateTraversals(stem: string): Enumeration | null {
  const bfs = /\b(?:BFS|breadth[- ]first)\b/i.test(stem);
  const dfs = /\b(?:DFS|depth[- ]first)\b/i.test(stem);
  if (bfs === dfs || !/\b(?:order|visit|visited|sequence)\b/i.test(stem) || TIE_BREAK.test(stem)) return null;
  const directed = /\bdirected\b/i.test(stem) && !/\bundirected\b/i.test(stem);
  const edges: [string, string][] = [];
  for (const m of stem.matchAll(/(?<![\w(])([A-Z]|\d{1,2})\s*(?:–|—|-|->|→|↔)\s*([A-Z]|\d{1,2})(?![\w])/g)) edges.push([m[1], m[2]]);
  for (const m of stem.matchAll(/\(\s*([A-Z]|\d{1,2})\s*,\s*([A-Z]|\d{1,2})\s*\)/g)) edges.push([m[1], m[2]]);
  const start = stem.match(/\b(?:from|at|starting (?:at|from)|start(?:ing)? (?:vertex|node)|source(?: vertex| node)?)\s+(?:vertex\s+|node\s+)?([A-Z]|\d{1,2})\b/);
  if (edges.length < 2 || !start) return null;
  const adj = new Map<string, Set<string>>();
  const add = (u: string, v: string) => (adj.get(u) ?? adj.set(u, new Set()).get(u)!).add(v);
  for (const [u, v] of edges) {
    add(u, v);
    if (!directed) add(v, u);
    if (directed && !adj.has(v)) adj.set(v, new Set());
  }
  if (adj.size > 10 || !adj.has(start[1])) return null;
  const LIMIT = 50;
  const orders = new Set<string>();
  const perms = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  if (bfs) {
    const go = (order: string[], queue: string[], seen: Set<string>) => {
      if (orders.size >= LIMIT) return;
      if (!queue.length) return void orders.add(order.join(", "));
      const [u, ...rest] = queue;
      const fresh = [...(adj.get(u) ?? [])].filter((v) => !seen.has(v));
      for (const p of perms(fresh)) go([...order, ...p], [...rest, ...p], new Set([...seen, ...p]));
    };
    go([start[1]], [start[1]], new Set([start[1]]));
  } else {
    const go = (order: string[], stack: string[]) => {
      if (orders.size >= LIMIT) return;
      if (!stack.length) return void orders.add(order.join(", "));
      const top = stack[stack.length - 1];
      const fresh = [...(adj.get(top) ?? [])].filter((v) => !order.includes(v));
      if (!fresh.length) return go(order, stack.slice(0, -1));
      for (const v of fresh) go([...order, v], [...stack, v]);
    };
    go([start[1]], [start[1]]);
  }
  return { problem: bfs ? "BFS order" : "DFS order", answers: [...orders], input: `${edges.map((e) => e.join(directed ? "→" : "–")).join(", ")} from ${start[1]}` };
}

const ENUMERATORS = [enumeratePairSums, enumerateTraversals];

/**
 * Rule a, in code: for a trace question on a small input we can enumerate, every answer that
 * is valid under the problem's definition. More than one is a failure, unless the question shows
 * the code and asks what THAT code returns.
 */
export function uniquenessProblems(q: CheckableQuestion): string[] {
  if (asksAboutShownCode(q)) return [];
  const out: string[] = [];
  for (const enumerate of ENUMERATORS) {
    const e = enumerate(q.stem);
    if (e && e.answers.length > 1) {
      const shown = e.answers.slice(0, 4).join(" and ") + (e.answers.length > 4 ? ` and ${e.answers.length - 4} more` : "");
      out.push(`${e.problem} on ${e.input} has ${e.answers.length} valid answers (${shown}); change the input so exactly one is valid, or show the code and ask what that code returns`);
    }
  }
  return out;
}

// ---------- code ----------

export function codeProblems(q: CheckableQuestion): string[] {
  if (!q.code || !q.code.lines.length) return [];
  const n = q.code.lines.filter((l) => l.trim()).length;
  return n < 3 || n > 8 ? [`the code block has ${n} lines (3 to 8)`] : [];
}

// ---------- all ----------

/** Every deterministic rule a question breaks, cheapest first. Empty means it may go to the model check. */
export function deterministicChecks(q: CheckableQuestion, ctx: { styleExamples?: string[] } = {}): RuleFailure[] {
  return [
    ...uniquenessProblems(q).map((reason) => ({ rule: "unique" as const, reason })),
    ...unseenReferences(q).map((r) => ({ rule: "standalone" as const, reason: `it refers to something not shown in the question: ${r}` })),
    ...optionProblems(q).map((reason) => ({ rule: "options" as const, reason })),
    ...styleProblems(q, ctx.styleExamples ?? []).map((reason) => ({ rule: "style" as const, reason })),
    ...codeProblems(q).map((reason) => ({ rule: "code" as const, reason })),
  ];
}
