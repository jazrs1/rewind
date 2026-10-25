// The example prompts on an empty Ask tab, from the courses on this device: what's coming up, a mixed practice set
// by the courses' nicknames, and what a lecturer said (or a topic to catch up on).

import { studyTopics } from "../study/topics.ts";
import type { AskCourse } from "./types.ts";

/**
 * The name an example prompt uses for a course: its code prefix ("MAS", "COP"), except where the title is a
 * conventional "A and B" acronym students say instead ("Data Structures and Algorithms" → "DSA"). Only the example
 * prompts choose; resolveCourse still accepts the initials, the title and the code when the student types them.
 */
export function exampleName(c: Pick<AskCourse, "code" | "title">): string {
  const words = c.title.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const big = words.filter((w) => !["and", "of", "the", "for", "in", "to", "a", "an", "with", "intro"].includes(w));
  if (words.includes("and") && big.length >= 3 && big.length <= 4) return big.map((w) => w[0]).join("").toUpperCase();
  return c.code.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? c.code;
}

export function examplesFor(courses: AskCourse[]): string[] {
  const out = ["What exams do I have in the next 2 weeks?"];
  const two = courses.slice(0, 2).map(exampleName);
  out.push(`Help me practice for ${two.join(" and ")}`);
  const withBank = courses.find((c) => c.bank?.tape);
  const top = withBank ? studyTopics(withBank.bank!.tape!, withBank.bank!.seed.questions.map((q) => q.id), withBank.bank!.gradedIds)[0] : undefined;
  if (top) out.push(`Explain ${top.name.toLowerCase()}, I'm behind`);
  else if (courses[0]?.lecturer) out.push(`What did ${courses[0].lecturer} say about the last lecture?`);
  return out;
}
