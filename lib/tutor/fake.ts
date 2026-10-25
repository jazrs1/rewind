// A fake tutor model for tests and the e2e dev server (REWIND_FAKE_LLM=1, development only): no network,
// no key, no spend. It answers from the prompt it is given, and when the student asks for the answer it
// gives it away on purpose, so the tests can prove the integrity check blocks it.

import type { SimilarJSON, TutorReplyJSON } from "../prompts/tutor.ts";
import type { SeedQuestion } from "../demo/types.ts";
import { materialOf, type Generate } from "./service.ts";
import type { GenerateSimilar } from "./similar.ts";

/** Is the fake model on? Never in a production or demo build. */
export function fakeLlmOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.REWIND_FAKE_LLM === "1" && env.NODE_ENV === "development" && env.REWIND_DEMO !== "1" && !env.VERCEL;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function fakeTutor(q: SeedQuestion, opts: { delayMs?: number } = {}): Generate {
  return async (prompt): Promise<TutorReplyJSON> => {
    await wait(opts.delayMs ?? 700);
    const line = prompt.match(/^\[\d+:\d{2}\] (.+)$/m)?.[1] ?? "";
    // Quotes the question's own passage and the first lecturer line, the way a careful model would.
    const claims = [...(line ? [{ quote: line }] : []), ...(q.source?.quote ? [{ quote: q.source.quote }] : [])];
    const said = prompt.match(/<student>([\s\S]*?)<\/student>/)?.[1] ?? "";
    const right = q.choices.find((c) => c.label === q.answer)!;
    const hint = prompt.match(/Give hint (\d) of at most/)?.[1];
    if (/weather|joke|poem|recipe|movie|football|ignore (?:all|your|the) (?:previous|rules|instructions)/i.test(said)) return { text: "I can only help with this question here.", claims: [], confirms: false };
    if (/Give the answer:/.test(prompt)) return { text: `The answer is (${right.label}) ${right.text}. That is what the course says.`, claims, confirms: true };
    if (/answer|tell me|just say|solution/i.test(said)) return { text: `Sure: the answer is (${right.label}) ${right.text}.`, claims, confirms: false };
    if (/similar/i.test(said)) return { text: "Here's a similar one to try: a table with 10 slots and 12 keys. What can you say about collisions, and why?", claims: [], confirms: false };
    if (hint === "1") return { text: "Start with what the question is really asking. How many things go in, and how many places can they land?", claims, confirms: false };
    if (hint === "2") return { text: "Now compare those two counts. What does the pigeonhole principle say when there are more things than places?", claims, confirms: false };
    if (/pigeon|share|at least|more than/i.test(said)) return { text: "Exactly, you reasoned it out. That is the idea the lecturer makes here:", claims, confirms: true };
    return { text: "What does the course say about this idea? Try saying it in your own words, and tell me which part is the sticking point.", claims, confirms: false };
  };
}

/**
 * The fake's similar question: the same question with every number moved by one shift that lands on none of the
 * question's own numbers (so the value check passes), a stem that says it's new, and the question's own quote (or the
 * first lecturer line) as its source, which the quote check finds word for word.
 */
export function fakeSimilar(q: SeedQuestion, opts: { delayMs?: number } = {}): GenerateSimilar {
  return async (prompt): Promise<SimilarJSON> => {
    await wait(opts.delayMs ?? 700);
    const all = [q.stem, ...(q.code?.lines ?? []), ...q.choices.map((c) => c.text)].join(" ");
    const mine = new Set((all.match(/\d+/g) ?? []).map(Number));
    let k = 3;
    while ([...mine].some((n) => mine.has(n + k) || n + k <= 1)) k++;
    const shift = (s: string) => s.replace(/\d+/g, (n) => String(Number(n) + k));
    const line = prompt.match(/^\[\d+:\d{2}\] (.+)$/m)?.[1] ?? "";
    return {
      stem: `New values: ${shift(q.stem)}`,
      code: (q.code?.lines ?? []).map(shift),
      choices: q.choices.map((c) => ({ label: c.label, text: /\d/.test(c.text) ? shift(c.text) : `${c.text} (new)` })),
      answer: q.answer,
      explanation: "The same idea as before, with new values.",
      // The question's quote when the material has it (its slide is the one shown, or it's a lecture line); else a
      // lecture line from the prompt, as a real model would have to.
      quote: q.source && (materialOf(q).slide || q.source.where.kind === "lecture") ? q.source.quote : line,
    };
  };
}
