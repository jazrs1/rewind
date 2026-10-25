// Builds the saved replies for every demo question (see tutor-pick.ts): Hint 1, Hint 2, a Socratic follow-up, a
// confirm and the answer, each through the same tutor prompt, integrity check and quote check as the live tutor
// (lib/tutor/service.ts tutorReply). The model is a parameter: lib/llm.ts for the real file, the fake in tests.

import type { SavedQuestion, SavedReply } from "../../components/tutor/types.ts";
import { tutorReply, type Generate, type TutorResult, type TutorTurnIn } from "../tutor/service.ts";
import { newValuesLine, similarQuestion, type GenerateSimilar, type SimilarCard } from "../tutor/similar.ts";
import type { DemoBundle } from "./bundle.ts";
import { SAVED_FORMAT, type SavedFile } from "./tutor-pick.ts";
import { sanitizeSaved } from "./tutor-saved.ts";

const asSaved = (r: TutorResult): SavedReply => ({ text: r.text, grounded: r.grounded });

export interface PrecomputeReport {
  questions: number;
  /** Replies the integrity check replaced with its fixed line (a model that gave the answer away, or an empty one). */
  rewritten: number;
  /** Replies with at least one quote-checked claim ("From your course"). */
  grounded: number;
  replies: number;
  /** Similar questions kept (each passed the value and quote checks), and the ones dropped. */
  similar: number;
  similarDropped: number;
}

/** How many similar questions to try per demo question. The second is asked to differ from the first. */
export const SAVED_SIMILAR = 2;

export async function precomputeTutor(bundle: DemoBundle, generate: Generate, model: string, generateSimilar?: GenerateSimilar): Promise<{ file: SavedFile; report: PrecomputeReport }> {
  const questions: Record<string, SavedQuestion> = {};
  const report: PrecomputeReport = { questions: 0, rewritten: 0, grounded: 0, replies: 0, similar: 0, similarDropped: 0 };
  for (const set of bundle.sets) {
    for (const question of set.seed.questions) {
      const base = { seed: set.seed, question, graded: false as const };
      const right = question.choices.find((c) => c.label === question.answer)!;
      const wrong = question.choices.find((c) => c.label !== question.answer)!;
      const run = async (o: { request: "hint" | "answer" | "reply"; message?: string; history: TutorTurnIn[]; marked: typeof question.answer | null }) => {
        const r = await tutorReply({ ...base, ...o }, generate);
        report.replies++;
        if (r.rewritten) report.rewritten++;
        if (r.grounded.length) report.grounded++;
        return r;
      };
      const hint1 = await run({ request: "hint", history: [], marked: null });
      const asHint = (r: TutorResult): TutorTurnIn => ({ role: "tutor", text: r.text, kind: "hint" });
      const hint2 = await run({ request: "hint", history: [asHint(hint1)], marked: null });
      const stuck = "I'm not sure where to start. Can you help me see it?";
      const afterHints: TutorTurnIn[] = [asHint(hint1), asHint(hint2)];
      const socratic = await run({ request: "reply", message: stuck, history: afterHints, marked: null });
      const reasoning = `So my answer is: ${right.text}.`;
      const confirm = await run({
        request: "reply",
        message: reasoning,
        history: [...afterHints, { role: "student", text: stuck }, { role: "tutor", text: socratic.text, kind: "reply" }],
        marked: right.label,
      });
      // The answer a student who marked a wrong choice sees.
      const answer = await run({ request: "answer", history: afterHints, marked: wrong.label });
      questions[question.id] = { hint1: asSaved(hint1), hint2: asSaved(hint2), socratic: asSaved(socratic), confirm: asSaved(confirm), answer: asSaved(answer) };
      if (generateSimilar) {
        // The live prompt; the second try also names the first so it comes out different. Each passes the live checks, as
        // for a student who has answered (a saved card can play before they have: the page then hides its source chip
        // when that would show the answer, lib/tutor/poll.ts).
        const similar: SimilarCard[] = [];
        for (let i = 0; i < SAVED_SIMILAR; i++) {
          const avoid = similar.map((c) => c.stem);
          const r = await similarQuestion({ ...base, graded: false, marked: wrong.label }, (p, schema) => generateSimilar(avoid.length ? `${p}\nWrite a different question from these: ${avoid.map((s) => `"${s}"`).join("; ")}.` : p, schema));
          if (r.card && !similar.some((c) => c.stem === r.card!.stem)) similar.push(r.card);
          else report.similarDropped++;
        }
        questions[question.id].similar = similar;
        report.similar += similar.length;
      }
      report.questions++;
    }
  }
  // The same chip rule as the live page (lib/tutor/poll.ts), slot by slot.
  return { file: sanitizeSaved({ format: SAVED_FORMAT, model, questions }, bundle), report };
}

export interface RetryReport {
  /** Questions that had fewer than SAVED_SIMILAR kept similar questions before this run. */
  retried: number;
  attempts: number;
  /** New similar questions kept (added after the kept ones), and attempts dropped, by the check that dropped them. */
  added: number;
  dropped: Record<string, number>;
  /** Questions still short of SAVED_SIMILAR afterwards. */
  stillShort: number;
  /** Questions not tried because the next call could pass the run's dollar cap. */
  skippedForCap: number;
}

/** The line that makes each retry a new prompt, so the model cache can't hand back the answer it already dropped. */
export const retryLine = (attempt: number) => `\nSaved retry ${attempt}: write a new question; don't repeat an earlier try.`;

/**
 * More tries at the saved similar questions, for the questions with fewer than SAVED_SIMILAR kept: up to `attempts`
 * calls each, numbered in the prompt (retryLine), until it has SAVED_SIMILAR. Each try also names the original's exact
 * values and asks for new ones (newValuesLine): most drops were questions that reused its numbers. Kept ones are
 * never replaced, only added to, and each new one is asked to differ from them. Everything else in the file stays as it is. `canSpend` is asked
 * before each call with that call's prompt; false skips the rest of that question and every one after it.
 */
export async function retrySimilar(
  bundle: DemoBundle,
  saved: SavedFile,
  generateSimilar: GenerateSimilar,
  attempts: number,
  canSpend: (prompt: string) => boolean = () => true,
): Promise<{ file: SavedFile; report: RetryReport }> {
  const report: RetryReport = { retried: 0, attempts: 0, added: 0, dropped: {}, stillShort: 0, skippedForCap: 0 };
  const questions: Record<string, SavedQuestion> = structuredClone(saved.questions);
  let capped = false;
  for (const set of bundle.sets) {
    for (const question of set.seed.questions) {
      const entry = questions[question.id];
      if (!entry) continue;
      const similar = [...(entry.similar ?? [])];
      if (similar.length >= SAVED_SIMILAR) continue;
      if (capped) {
        report.skippedForCap++;
        report.stillShort++;
        continue;
      }
      report.retried++;
      const wrong = question.choices.find((c) => c.label !== question.answer)!;
      const values = newValuesLine(question);
      for (let attempt = 1; attempt <= attempts && similar.length < SAVED_SIMILAR; attempt++) {
        const avoid = similar.map((c) => `"${c.stem}"`).join("; ");
        const r = await similarQuestion({ seed: set.seed, question, graded: false, marked: wrong.label }, (p, schema) => {
          const prompt = `${p}${values}${avoid ? `\nWrite a different question from these: ${avoid}.` : ""}${retryLine(attempt)}`;
          if (!canSpend(prompt)) {
            capped = true;
            throw new Error("over the run's cap");
          }
          report.attempts++;
          return generateSimilar(prompt, schema);
        }).catch((e: unknown) => {
          if (capped) return null;
          throw e;
        });
        if (!r) break;
        if (r.card && !similar.some((c) => c.stem === r.card!.stem)) {
          similar.push(r.card);
          report.added++;
        } else {
          const why = r.card ? "duplicate" : (r.problem ?? "other");
          report.dropped[why] = (report.dropped[why] ?? 0) + 1;
        }
      }
      entry.similar = similar;
      if (similar.length < SAVED_SIMILAR) report.stillShort++;
    }
  }
  return { file: sanitizeSaved({ ...saved, questions }, bundle), report };
}
