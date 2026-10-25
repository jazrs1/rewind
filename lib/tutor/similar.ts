// "Give me a similar one" on practice: a NEW multiple-choice question on the same idea, with new values, that the
// student answers inside the chat (components/tutor/SimilarCard.tsx). Graded work never gets one: the request is
// refused before any model call (integrity mode). What the model writes is checked before the student sees it:
//   - shape: a stem, four distinct choices A to D, a key among them, at most 30 code lines;
//   - new values: none of the question's numbers anywhere in it (sharedValues, the reusesValues rule without a
//     trigger word), and not the same question back;
//   - grounding: its source quote is found word for word in the course material (quoteIn via groundClaims), and
//     links to its moment or slide. A question with no grounded quote is dropped.
// A dropped question is never repaired: the dev route says so plainly, the demo plays a saved one (tutor.json).

import { SIMILAR_SCHEMA, similarPrompt, type SimilarJSON, type TutorScope } from "../prompts/tutor.ts";
import type { PracticeSeed, SeedQuestion } from "../demo/types.ts";
import type { ChoiceLabel } from "../schema.ts";
import { groundClaims, type Grounded, type Material } from "./claims.ts";
import { normalize, sharedValues, valuesOf } from "./integrity.ts";
import { safeChips } from "./poll.ts";
import { materialOf, questionInput } from "./service.ts";

export interface SimilarCard {
  stem: string;
  code: { language: string; lines: string[] } | null;
  choices: { label: ChoiceLabel; text: string }[];
  answer: ChoiceLabel;
  explanation: string;
  /** The course material it rests on, found word for word: its moment (a mini-tape chip) or its slide. */
  source: Grounded;
}

export type GenerateSimilar = (prompt: string, schema: object) => Promise<SimilarJSON>;

/**
 * The question's own values, for a retry to steer away from: its numbers (the ones checkSimilar refuses to see again,
 * 0 and 1 aside), the arrays and sets it writes out, and its graph's node labels (single capital letters named as
 * vertices or nodes, in edges like A–B or A→B, and in sets like {A, D}).
 */
export function originalValues(q: Pick<SeedQuestion, "stem" | "code" | "choices">): { numbers: string[]; arrays: string[]; labels: string[] } {
  const text = normalize([q.stem, ...(q.code?.lines ?? []), ...q.choices.map((c) => c.text)].join("\n"));
  const numbers = [...valuesOf(q)].sort((a, b) => Number(a) - Number(b));
  const arrays = [...new Set(text.match(/\[\s*\([^\]\n]*\]|[[{]\s*[\w'".-]+(?:\s*,\s*[\w'".-]+)+\s*[\]}]/g) ?? [])];
  const labels = new Set<string>();
  const add = (s: string) => (s.match(/\b[A-Z]\b/g) ?? []).forEach((l) => labels.add(l));
  for (const m of text.matchAll(/\b(?:vertex|vertices|node|nodes)\s+([A-Z](?:\s*,\s*(?:and\s+)?[A-Z])*(?:,?\s+and\s+[A-Z])?)\b/g)) add(m[1]);
  for (const m of text.matchAll(/\b([A-Z])\s*(?:-|–|->|→)\s*([A-Z])\b/g)) add(`${m[1]} ${m[2]}`);
  for (const m of text.matchAll(/[{(]\s*([A-Z](?:\s*,\s*[A-Z])+)\s*[})]/g)) add(m[1]);
  return { numbers, arrays, labels: [...labels].sort() };
}

/**
 * What a retry adds to the prompt: the original's exact values, and the rule that the new question uses none of them
 * (new numbers, new array contents, new node labels) while testing the same idea. Empty when the question has none.
 */
export function newValuesLine(q: Pick<SeedQuestion, "stem" | "code" | "choices">): string {
  const v = originalValues(q);
  const parts = [
    v.numbers.length ? `numbers ${v.numbers.join(", ")}` : null,
    v.arrays.length ? `arrays and sets ${v.arrays.join("; ")}` : null,
    v.labels.length ? `node labels ${v.labels.join(", ")}` : null,
  ].filter(Boolean);
  if (!parts.length) return "";
  return `\nThe original question uses exactly these values: ${parts.join("; ")}. Your question must use none of them: pick different numbers, different array contents and different node labels, while testing the same idea. A question that repeats any of these numbers is dropped.`;
}

export interface SimilarCall {
  seed: PracticeSeed;
  question: SeedQuestion;
  graded: boolean;
  /** What the student has answered on the question itself; null = not yet, so no poll or answer slide is shown. */
  marked?: ChoiceLabel | null;
  /** What the tutor stays on, set by the route (default: this question). */
  scope?: TutorScope;
}

export interface SimilarResult {
  text: string;
  card: SimilarCard | null;
  /** Refused without a model call (graded work). */
  refused: boolean;
  /** Why the model's question was dropped, when it was ("values", "ungrounded"…). Never shown. */
  problem?: string;
}

export const SIMILAR_REFUSAL =
  "I won't write a question like this one on graded work: it would solve this one by another route. Tell me which idea you're stuck on, and I'll ask you questions to get there.";
export const SIMILAR_FAILED = "I couldn't make a new one I could check against your course just now. Try again, or ask for a hint.";
export const SIMILAR_INTRO = "Here's a new one on the same idea, with new values. Mark your answer:";

/** The words a similar-question turn stands for in the history (and what its signature covers): the intro and the question. */
export const similarTurnText = (card: Pick<SimilarCard, "stem" | "choices">) => `${SIMILAR_INTRO} ${card.stem} ${card.choices.map((c) => `(${c.label}) ${c.text}`).join(" ")}`;

const LABELS: ChoiceLabel[] = ["A", "B", "C", "D"];
/** Caps that keep similarTurnText (intro + stem + four choices) well under MAX_TURN_CHARS, so its signature still verifies. */
export const MAX_STEM = 400;
export const MAX_CHOICE = 150;
const flat = (s: string) => normalize(s).toLowerCase().replace(/\s+/g, " ").trim();
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/** The model's question, checked; the reason it was dropped otherwise. */
export function checkSimilar(raw: unknown, q: SeedQuestion, m: Material = materialOf(q)): { card: SimilarCard } | { problem: string } {
  const r = (raw ?? {}) as Partial<Record<keyof SimilarJSON, unknown>>;
  const stem = str(r.stem, MAX_STEM);
  const explanation = str(r.explanation, 600) ?? "";
  const quote = str(r.quote, 600);
  if (!stem || !quote) return { problem: "shape" };
  const lines = Array.isArray(r.code) ? r.code.filter((l): l is string => typeof l === "string") : [];
  if (lines.length > 30 || lines.some((l) => l.length > 200)) return { problem: "shape" };
  const list = Array.isArray(r.choices) ? (r.choices as { label?: unknown; text?: unknown }[]) : [];
  const choices = LABELS.map((label) => {
    const hit = list.filter((c) => c && c.label === label);
    return hit.length === 1 ? { label, text: str(hit[0].text, MAX_CHOICE) } : null;
  });
  if (list.length !== 4 || choices.some((c) => !c || !c.text)) return { problem: "shape" };
  const four = choices as { label: ChoiceLabel; text: string }[];
  if (new Set(four.map((c) => flat(c.text))).size !== 4) return { problem: "shape" };
  if (typeof r.answer !== "string" || !LABELS.includes(r.answer as ChoiceLabel)) return { problem: "shape" };
  // The same right answer as the question's would answer it by another route.
  const right = flat(four.find((c) => c.label === r.answer)!.text);
  if (right === flat(q.choices.find((c) => c.label === q.answer)?.text ?? "")) return { problem: "same-answer" };
  // The same question back (its stem, or all its choices) isn't a new one.
  if (flat(stem) === flat(q.stem) || q.choices.every((c) => four.some((n) => flat(n.text) === flat(c.text)))) return { problem: "same" };
  // New values: none of the question's numbers, anywhere the student reads.
  if (sharedValues([stem, ...lines, ...four.map((c) => c.text), explanation].join("\n"), q).length) return { problem: "values" };
  const [source] = groundClaims([{ quote }], m);
  if (!source) return { problem: "ungrounded" };
  const code = lines.length ? { language: q.code?.language ?? "text", lines } : null;
  return { card: { stem, code, choices: four, answer: r.answer as ChoiceLabel, explanation, source } };
}

/** What is sent to the model for a similar question. Exported so the data-flow list and its test read the same thing. */
export function similarInput(c: SimilarCall) {
  return { course: c.seed.course, question: questionInput(c.question), lecture: materialOf(c.question).lecture, scope: c.scope };
}

/** The live prompt: the similar prompt plus the original's exact values to avoid (the precompute's retry line). */
export function liveSimilarPrompt(c: SimilarCall): string {
  return similarPrompt(similarInput(c)) + newValuesLine(c.question);
}

export async function similarQuestion(c: SimilarCall, generate: GenerateSimilar, opts: { retryUntil?: number; now?: () => number } = {}): Promise<SimilarResult> {
  if (c.graded) return { text: SIMILAR_REFUSAL, card: null, refused: true };
  // An offline error or a spend cap throws to the caller, which shows its own message (or, in the demo, a saved one).
  const prompt = liveSimilarPrompt(c);
  let checked = checkSimilar(await generate(prompt, SIMILAR_SCHEMA), c.question);
  // One retry when the first one failed its checks and there is still time before the reply is due.
  const now = opts.now ?? Date.now;
  if ("problem" in checked && opts.retryUntil !== undefined && now() < opts.retryUntil) {
    checked = checkSimilar(await generate(`${prompt}\nYour first try was dropped (${checked.problem}). Write a different question that passes every rule.`, SIMILAR_SCHEMA), c.question);
  }
  if ("problem" in checked) return { text: SIMILAR_FAILED, card: null, refused: false, problem: checked.problem };
  // Its source chip shows once the card is checked, but the student may not have answered the question itself yet: a
  // source that gives that answer away, or a poll or answer slide, means the card isn't shown.
  const [source] = safeChips([checked.card.source], c.question, { answered: (c.marked ?? null) !== null, graded: false, hint: false });
  if (!source) return { text: SIMILAR_FAILED, card: null, refused: false, problem: "reveals" };
  return { text: SIMILAR_INTRO, card: checked.card, refused: false };
}
