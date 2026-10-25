// Academic integrity for the tutor. On graded work (and in every hint) the tutor never gives the answer:
// the prompt says so, the correct answer isn't even in a graded prompt, and these checks run on whatever
// the model wrote anyway. A reply that gives the answer away is replaced, never shown.
//
// The checks are deterministic rules, not a promise that a determined student can't get round them:
//   revealsAnswer     the right choice by letter (any case), ordinal ("the second one", "option two"),
//                     elimination ("not A, not C, not D"), its text, a close paraphrase of its text, or a
//                     short answer written as a number or a word ("2", "two");
//   statesConclusion  graded only: any verdict on which choice holds or fails, or on the student's answer;
//   reusesValues      graded only: a worked or "similar" example that reuses the question's numbers;
//   sharedValues      the same rule with no trigger word: a generated similar question (lib/tutor/similar.ts) uses
//                     none of the question's numbers anywhere, in its stem, code or choices.

import type { ChoiceLabel } from "../schema.ts";
import type { TutorMode } from "../prompts/tutor.ts";

export interface KeyedQuestion {
  answer: ChoiceLabel;
  choices: { label: ChoiceLabel; text: string }[];
  /** The question's own words: a content word the stem already says isn't news. */
  stem?: string;
  code?: { lines: string[] } | null;
}

/** Letters that look like Latin ones (Greek, Cyrillic), so "Β" or "а" can't dodge a match. */
const LOOKALIKE: Record<string, string> = {
  "\u0391": "A", "\u0392": "B", "\u03f9": "C", "\u0410": "A", "\u0412": "B", "\u0421": "C",
  "\u03b1": "a", "\u03b2": "b", "\u0430": "a", "\u0441": "c", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0445": "x", "\u0456": "i", "\u03bf": "o",
};

/**
 * What every check reads: NFKC (fullwidth and enclosed letters become plain ones), no zero-width characters,
 * look-alike Greek and Cyrillic letters made Latin, one space between words, no space before punctuation
 * ("say b ." = "say b."), and no thousands commas ("1,024" = "1024"). Line breaks stay: they end sentences.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "")
    .replace(/[\u0391\u0392\u03f9\u0410\u0412\u0421\u03b1\u03b2\u0430\u0441\u0435\u043e\u0440\u0445\u0456\u03bf]/g, (c) => LOOKALIKE[c])
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ +([.,!?;:)])/g, "$1")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
}

const LABELS: ChoiceLabel[] = ["A", "B", "C", "D"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Lowercase words only: punctuation and spacing don't hide a repeated answer. */
const flat = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9'|^=+*/<>%()-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** A keyword in any case. */
const ci = (words: string) => words.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

/** The letter as a token: any case, except that a bare lowercase "a" (the article) only counts before punctuation or the end. */
const letterToken = (L: ChoiceLabel) => (L === "A" ? "(?:A|a(?=[.,!?;:)]|\\s*$))" : `(?:[${L}${L.toLowerCase()}]|${ci(L.toLowerCase() + "ee")})`);

const ORDINALS: [string, string][] = [
  ["first|1st", "one|1"],
  ["second|2nd", "two|2"],
  ["third|3rd", "three|3"],
  ["fourth|4th", "four|4"],
];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

const STOP = new Set(
  "the a an and or of to in on at is are was be it its this that these those for with by as from into than then so not no yes do does can will would should could may might more most less least each every any all some one two only just also even still when where which what who how why".split(" "),
);
/** Content words, cut to five letters so "climbs" and "climbing" meet. */
const stems = (s: string) => new Set(flat(s).split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)));

function letterGivenAway(text: string, q: KeyedQuestion): boolean {
  const L = q.answer;
  const LT = letterToken(L);
  const i = LABELS.indexOf(L);
  const [ordWords, ordNums] = ORDINALS[i] ?? ORDINALS[0];
  const ords = ci(ordWords);
  const ordsAny = `${ords}|${ci(ordNums)}`;
  const patterns = [
    new RegExp(`\\(${LT}\\)`), // "(B)"
    new RegExp(`\\b${LT}\\)`), // "B)"
    new RegExp(`\\b(?:${ci("option|choice|letter|answer")})\\s*(?:${ci("is")}|:)?\\s*\\(?${LT}\\b`), // "option B", "answer is b"
    new RegExp(`\\b(?:${ci("answer|correct|right|pick|choose|select|go with|going with|say|think|guess|take|lean|vote|bet")})\\b[^.?!\\n]{0,24}?\\b${LT}\\b(?![\\w'-])`), // "The correct answer is B", "I'd go with b."
    new RegExp(`(?:^|[\\s"“(])${LT}\\s+(?:${ci("is|would be")})\\s+(?:${ci("the")}\\s+)?(?:${ci("correct|right|answer")})`), // "B is correct"
    new RegExp(`\\b(?:${ci("it's|it is|that's|that is")})\\s+(?:(?:${ci("option|choice")})\\s+)?${LT}\\b(?![\\w'-])`), // "it's B"
    new RegExp(`(?:^|[.!?]\\s+|\\n)\\(?${LT}\\)?\\s*(?:[,.!:]|$)`), // "B, obviously", "B."
    new RegExp(`\\b(?:${ci("the")})\\s+(?:${ords})\\s+(?:${ci("one|option|choice|answer")})\\b`), // "the second one"
    new RegExp(`\\b(?:${ci("option|choice|number|letter")})\\s*(?:${ci("is|number")}|#|:)?\\s*(?:${ci("the")}\\s+)?(?:${ordsAny})\\b`), // "option two", "choice 2"
    new RegExp(`\\b(?:${ci("it's|it is|that's|that is|go with|pick|choose|select")})\\s+(?:${ci("the")}\\s+)?(?:${ords})\\b`), // "it's the second"
  ];
  // A list of lettered points ("a) sort them, and b) hash them") isn't a choice: with two or more different markers,
  // the bare "(B)" and "B)" forms are skipped (a stated answer still shows through "the answer is b)", "go with (b)"…).
  const markers = new Set([...text.matchAll(/(?:^|[\s,;(])\(?([A-Da-d])\)(?=\s|$)/g)].map((m) => m[1].toLowerCase()));
  const list = markers.size >= 2;
  return patterns.some((re, i) => !(list && i < 2) && re.test(text));
}

/** "Not A, not C, not D": the wrong choices ruled out one by one leave the right one. */
function eliminatesToAnswer(text: string, q: KeyedQuestion): boolean {
  const wrong = new Set(q.choices.map((c) => c.label).filter((l) => l !== q.answer));
  if (wrong.size < 2) return false;
  const ruledOut = new Set<string>();
  for (const seg of text.match(/\b(?:not|neither|nor|eliminate|eliminated|rule out|ruled out|cross out|crossed out|wrong|incorrect|false)\b[^.?!\n]*/gi) ?? []) {
    for (const m of seg.matchAll(/\(?\b([A-D])\b\)?/g)) if (wrong.has(m[1] as ChoiceLabel)) ruledOut.add(m[1]);
  }
  // Letters named before the verdict word: "A, C and D are wrong".
  for (const sent of text.split(/[.?!\n]+/)) {
    if (!/\b(?:wrong|incorrect|false|out|eliminated|don't work|doesn't work|can't be)\b/i.test(sent)) continue;
    for (const m of sent.matchAll(/\(?\b([A-D])\b\)?/g)) if (wrong.has(m[1] as ChoiceLabel)) ruledOut.add(m[1]);
  }
  // The same by position or spelled-out letter: "not the first, not the third, not the fourth".
  const index: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, bee: 1, cee: 2, dee: 3 };
  const labels = q.choices.map((c) => c.label);
  for (const seg of text.match(/\b(?:not|neither|nor|eliminate|eliminated|rule out|ruled out|cross out|crossed out|wrong|incorrect|false)\b[^.?!\n]*/gi) ?? []) {
    for (const m of seg.matchAll(/\b(first|1st|second|2nd|third|3rd|fourth|4th|bee|cee|dee)\b/gi)) {
      const l = labels[index[m[1].toLowerCase()]];
      if (l && wrong.has(l)) ruledOut.add(l);
    }
  }
  return ruledOut.size >= wrong.size;
}

function textGivenAway(text: string, q: KeyedQuestion): boolean {
  const correct = q.choices.find((c) => c.label === q.answer)?.text ?? "";
  const key = flat(correct);
  if (!key) return false;
  const body = ` ${flat(text)} `;
  // A real phrase (two words, or five characters) repeated anywhere gives it away.
  if (key.split(" ").length >= 2 || key.length >= 5) {
    if (body.includes(` ${key} `) || body.includes(` ${key}.`)) return true;
    // A close paraphrase: the reply uses most of the right choice's content words and clearly more of them than any other choice's.
    const own = stems(correct);
    const said = stems(text);
    // Words every choice shares say nothing about which one it is.
    const shared = new Set([...own].filter((w) => q.choices.every((c) => stems(c.text).has(w))));
    const distinct = new Set([...own].filter((w) => !shared.has(w)));
    // A telling word: one the right choice has and no other choice does, which the question didn't already say.
    // Using it ("It's logarithmic.", "Use hashing.") while saying none of the other choices' own words points at it.
    const known = stems(`${q.stem ?? ""} ${(q.code?.lines ?? []).join(" ")}`);
    const telling = [...distinct].filter((w) => w.length >= 4 && !known.has(w));
    const others = q.choices.filter((c) => c.label !== q.answer).flatMap((c) => [...stems(c.text)].filter((w) => !shared.has(w) && !own.has(w)));
    if (telling.some((w) => said.has(w)) && !others.some((w) => said.has(w))) return true;
    return false;
  }
  // A short answer ("2", "O(1)") is only a leak where the tutor states it as the result, as a number or in words.
  const forms = [esc(key)];
  const n = /^\d+$/.test(key) ? Number(key) : NUMBER_WORDS.indexOf(key);
  if (n >= 0 && n < NUMBER_WORDS.length) forms.push(String(n), NUMBER_WORDS[n]);
  const said = new RegExp(`(?:^|[^a-z])(?:answer|correct|right|result|equals?|is|are|be|as|to|gives?|makes?|total|it's|that's|exactly|precisely|use|using|=|:)\\s*(?:exactly\\s+|precisely\\s+|just\\s+|only\\s+)?(?:${[...new Set(forms)].join("|")})(?![a-z0-9])`).test(body);
  // "runs twice", "three times over": the count as a word of its own.
  const counted = n === 2 ? /(?:^|[^a-z])twice(?![a-z])/.test(body) : n === 3 ? /(?:^|[^a-z])thrice(?![a-z])/.test(body) : false;
  return said || counted;
}

/**
 * Does this text already contain the right answer, as a student's own words or an earlier verified turn would: the
 * choice's text (a short answer as a whole word) or any way of naming it that revealsAnswer knows.
 */
export function mentionsAnswer(raw: string, q: KeyedQuestion): boolean {
  const text = normalize(raw);
  const correct = flat(normalize(q.choices.find((c) => c.label === q.answer)?.text ?? ""));
  const body = ` ${flat(text)} `;
  if (correct && body.includes(` ${correct} `)) return true;
  if (correct && correct.length < 5 && new RegExp(`(?:^|[^a-z0-9])${esc(correct)}(?![a-z0-9])`).test(` ${flat(text)} `)) return true;
  return revealsAnswer(text, q);
}

/** Does the text say which choice is right: by letter, ordinal, elimination, its text, a paraphrase of it, or a short answer in words? */
export function revealsAnswer(raw: string, q: KeyedQuestion): boolean {
  const text = normalize(raw);
  const k: KeyedQuestion = { ...q, choices: q.choices.map((c) => ({ ...c, text: normalize(c.text) })) };
  return letterGivenAway(text, k) || eliminatesToAnswer(text, k) || textGivenAway(text, k);
}

/**
 * Graded work: a verdict on which choice holds or fails, or on whether the student is right, is itself the
 * answer by another route ("A is wrong", "you're right", "that works"). Questions don't match: "What would make
 * it correct?" has no verdict.
 */
export function statesConclusion(raw: string): boolean {
  const text = normalize(raw);
  const verdict = "correct|right|wrong|incorrect|false|true|valid|invalid";
  return [
    new RegExp(`\\b(?:you(?:'re| are)|that(?:'s| is)|this(?:'s| is)|it(?:'s| is)|yes,? (?:that|it)(?:'s| is))\\s+(?:exactly\\s+|absolutely\\s+|totally\\s+|completely\\s+)?(?:${verdict})\\b`, "i"),
    new RegExp(`\\b(?:(?:option|choice|answer)\\s*)?\\(?[A-D]\\)?\\s+(?:(?:is|are|would be|isn't|is not|can't be)\\s+(?:the\\s+)?(?:${verdict}|answer)|holds|fails|works|doesn't work|does not work)\\b`, "i"),
    /\b(?:the|a)\s+(?:correct|right)\s+(?:answer|choice|option)\b/i,
    /\b(?:isn't|is not|not)\s+the\s+(?:answer|one)\b/i,
    /\b(?:is|are)\s+(?:the\s+)?(?:correct|right|wrong|incorrect)\s+(?:answer|choice|option|one)\b/i,
    /\b(?:you got it|nailed it|well done|spot on|bingo)\b/i,
    // A bare verdict on its own: "Correct!", "Right.", "Exactly.", "Yes,", "Nope."
    /(?:^|[.!?]\s+|\n)\s*(?:correct|right|exactly|yes|yep|yeah|precisely|absolutely|indeed|true|false|wrong|incorrect|nope|no)\s*[!.,]/i,
    /\b(?:holds up|stands up|checks out|sounds right|looks right|looks good|that works|that'll work|keep (?:that|your|it|this)\b[^.?!]{0,30}answer|keep it as is|stick with (?:that|it|your|this)|your answer (?:is|looks|seems|sounds)|(?:change|don't change|no need to change) your answer)\b/i,
  ].some((re) => re.test(text));
}

type Valued = { stem: string; code?: { lines: string[] } | null; choices: { text: string }[] };
/** The numbers a text uses, without 0 and 1 (every example has those). */
const numbersIn = (s: string) => new Set((normalize(s).match(/\b\d+(?:\.\d+)?\b/g) ?? []).filter((n) => n !== "0" && n !== "1"));
export const valuesOf = (q: Valued) => numbersIn([q.stem, ...(q.code?.lines ?? []), ...q.choices.map((c) => c.text)].join(" "));

/** The question's numbers that this text uses again (any text: a stem, a choice, code). */
export function sharedValues(raw: string, q: Valued): string[] {
  const mine = valuesOf(q);
  return [...numbersIn(raw)].filter((n) => mine.has(n));
}

/** Graded work: an example, or a "similar problem", that reuses a number from the question. */
export function reusesValues(raw: string, q: Valued): boolean {
  const text = normalize(raw);
  if (!/\b(?:similar|for example|for instance|e\.g\.|suppose|let's say|let us say|imagine|consider|work through|try this)\b/i.test(text)) return false;
  return sharedValues(text, q).length > 0;
}

/** What the student sees instead of a reply that gave the answer away. No claims, so no "From your course". */
export function safeReply(mode: TutorMode, graded: boolean): string {
  if (graded) return "I won't give the answer on graded work, but I'll guide you to it. Tell me what you've tried so far, and what you think the question is really asking.";
  if (mode === "hint") return "Here's a place to start: say in your own words what the question is asking, and what the course says about that idea.";
  return "Let's work it out together: what do you already know about this idea, and which part is the sticking point?";
}

/**
 * Should this reply be checked for giving the answer away? Always on graded work and for hints; a Socratic
 * reply on practice may confirm what the student reasoned out; the answer itself is what the student asked for.
 */
export function mustNotReveal(mode: TutorMode, graded: boolean, confirms: boolean): boolean {
  if (graded) return true;
  if (mode === "hint") return true;
  if (mode === "socratic") return !confirms;
  return false;
}
