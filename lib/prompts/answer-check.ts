// Answer-check prompt (claude-opus-5-5, effort high): a separate call answers the question blind
// (it never sees the key or the explanation) and judges it against John's quality rules. The
// deterministic half of each rule runs first in code (lib/questions/rules.ts); this is the half
// that needs reading.

import { fencedPassages, type Passage, passageBlock, QUALITY_RULES } from "./question-gen.ts";

export const VERSION = "answer-check@2";

export interface AnswerCheckInput {
  course: { code: string; name: string };
  passages: Passage[];
  styleExamples: string[];
  /** The passages are a student's own text (Quick build): fenced and said to be data. */
  fence?: boolean;
  question: {
    stem: string;
    code?: { language: string; lines: string[] } | null;
    choices: { label: string; text: string }[];
    quote: string;
  };
}

export interface AnswerCheckReply {
  /** The checker's own answer, chosen without seeing the key. */
  answer: "A" | "B" | "C" | "D";
  why: string;
  /** Exactly one choice is defensibly correct from the material, and the stem is clear. */
  unambiguous: boolean;
  /** Rule 1: one answer under the problem's definition, not only under one implementation. */
  uniqueUnderDefinition: boolean;
  /** Rule 2: refers to nothing that isn't shown in the question. */
  standsAlone: boolean;
  /** Rule 3: short, parallel options, none explaining or giving itself away. */
  optionsParallel: boolean;
  /** Rule 4: phrasing and length like the course's own questions. */
  soundsLikeCourse: boolean;
  /** The cited passage supports the checker's answer. */
  quoteSupports: boolean;
  problems: string;
}

export const ANSWER_CHECK_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", enum: ["A", "B", "C", "D"] },
    why: { type: "string", description: "One sentence" },
    unambiguous: { type: "boolean", description: "Exactly one choice is defensibly correct from the material, and the stem is clear" },
    uniqueUnderDefinition: { type: "boolean", description: "Rule 1 holds" },
    standsAlone: { type: "boolean", description: "Rule 2 holds" },
    optionsParallel: { type: "boolean", description: "Rule 3 holds" },
    soundsLikeCourse: { type: "boolean", description: "Rule 4 holds" },
    quoteSupports: { type: "boolean", description: "The cited passage supports your answer" },
    problems: { type: "string", description: "What breaks a rule or is unclear, or empty" },
  },
  required: ["answer", "why", "unambiguous", "uniqueUnderDefinition", "standsAlone", "optionsParallel", "soundsLikeCourse", "quoteSupports", "problems"],
};

export function answerCheckPrompt({ course, passages, styleExamples, question, fence }: AnswerCheckInput): string {
  const code = question.code && question.code.lines.length ? `\nCODE SHOWN WITH THE QUESTION (${question.code.language || "code"})\n${question.code.lines.join("\n")}\n` : "";
  const style = styleExamples.length ? `\nQUESTIONS FROM THE COURSE'S PAST REVIEWS AND QUIZZES (the style to match)\n${styleExamples.map((e) => `- ${e}`).join("\n")}\n` : "";
  return `You check practice questions for ${course.code} (${course.name}) before students see them.

Below is the course material the question must be answerable from (lecture lines start with their time in the recording).

${fence ? fencedPassages(passages) : passages.map(passageBlock).join("\n\n")}
${style}
QUESTION
${question.stem}
${code}${question.choices.map((c) => `(${c.label}) ${c.text}`).join("\n")}

PASSAGE CITED AS SUPPORT
"${question.quote}"

Answer the question yourself from the material. Then judge it:
- unambiguous: exactly one choice is defensibly correct (false if two choices could be argued, none is right, or the stem is unclear).
- uniqueUnderDefinition, standsAlone, optionsParallel, soundsLikeCourse: whether each of these rules holds.
${QUALITY_RULES}
For rule 1, work out every valid answer to the problem as defined, not just the one a particular implementation would return; if the question shows code and asks what that code returns, the code decides. For rule 2, the student sees only the stem, the code shown (if any) and the choices.
- quoteSupports: the cited passage supports your answer.${fence ? `\n- For soundsLikeCourse: false if the question is about how the course runs (its grading, graded components, assignments, quizzes, exams or projects, schedule, deadlines, policies, staff or platforms) or about how its material is laid out (which video, module or page covers what) rather than the subject itself.` : ""}

Return:
- answer: the letter you choose.
- why: one sentence on why that choice is right.
- unambiguous, uniqueUnderDefinition, standsAlone, optionsParallel, soundsLikeCourse, quoteSupports: true or false.
- problems: what breaks a rule or is unclear, or an empty string.`;
}
