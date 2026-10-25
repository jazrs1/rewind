// No answer leaks in an Ask reply. The prompt says never to give away a practice card's answer before the student
// answers it; this is the code that holds it: the demo route runs every answer through blockLeaks before it goes back.
// The questions it checks are the ones the student hasn't answered yet: the page's open card ids and this turn's
// get_questions picks, both resolved against the server's own bank, plus the bank's graded questions. The test is the
// tutor's (lib/tutor/integrity.ts revealsAnswer): the right letter, ordinal, elimination, its text or a paraphrase of it,
// stated as the answer. Naming a letter in another sense ("plan A", "a B-tree") is not a leak.

import { revealsAnswer } from "../tutor/integrity.ts";
import type { SeedQuestion } from "../demo/types.ts";
import type { AskCourse, ToolRound } from "./types.ts";

export const LEAK_REFUSAL = "I can't give you the answer to a practice question you haven't answered yet. Want a hint to get you started instead?";

/** The bank questions this reply must not answer: open ids, this turn's practice picks, and graded ones. */
export function unansweredOf(courses: AskCourse[], openIds: string[], rounds: ToolRound[]): SeedQuestion[] {
  const ids = new Set(openIds);
  for (const r of rounds)
    r.calls.forEach((c, i) => {
      if (c.tool !== "get_questions") return;
      try {
        for (const q of (JSON.parse(r.results[i]) as { questions?: { id?: unknown }[] }).questions ?? []) if (typeof q.id === "string") ids.add(q.id);
      } catch {
        // A result that isn't JSON shows no cards.
      }
    });
  return courses.flatMap((c) => (c.bank?.seed.questions ?? []).filter((q) => ids.has(q.id) || c.bank!.gradedIds.includes(q.id)));
}

/** The reply as it may be shown: the refusal (and no claims) when it gives away an unanswered question's answer. */
export function blockLeaks<T extends { text: string; claims: unknown[] }>(reply: T, questions: SeedQuestion[]): T & { blocked: boolean } {
  const leaks = questions.some((q) => revealsAnswer(reply.text, q) || (reply.claims as { quote?: unknown }[]).some((c) => typeof c?.quote === "string" && revealsAnswer(c.quote, q)));
  return leaks ? { ...reply, text: LEAK_REFUSAL, claims: [], blocked: true } : { ...reply, blocked: false };
}
