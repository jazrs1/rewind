// The demo course's exam card, behind one flag, off by default: NEXT_PUBLIC_REWIND_DEMO_EXAMS=1 shows the next exam
// (countdown and its quote) on the demo Course tape. Off, the demo is exactly as it was: the page doesn't read the
// exams file and renders nothing for it. Pure; the countdown is the course home's (lib/home/build.ts countdownOf).

import { countdownOf } from "../home/build.ts";
import type { HomeExam, HomeExamInput } from "../home/types.ts";
import { EXAM_KEYS, type DemoExam, type DemoExamsFile } from "./exams.ts";

type Env = Record<string, string | undefined>;

export function demoExamsEnabled(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_REWIND_DEMO_EXAMS === "1";
}

/** The exams file, checked: exactly the four keys, strings where strings go. Throws on anything else. */
export function parseDemoExams(raw: unknown): DemoExamsFile {
  const f = raw as Partial<DemoExamsFile> | null;
  if (!f || typeof f.course !== "string" || !Array.isArray(f.exams)) throw new Error("exams.json: not { course, exams }");
  const str = (v: unknown) => v === null || typeof v === "string";
  for (const e of f.exams as DemoExam[]) {
    const keys = Object.keys(e ?? {}).sort();
    if (keys.join() !== [...EXAM_KEYS].sort().join()) throw new Error(`exams.json: an exam has keys ${keys.join(", ")}`);
    if (!str(e.date) || !str(e.title) || typeof e.quote !== "string" || !e.quote || !(e.coverage === null || (Array.isArray(e.coverage) && e.coverage.every((c) => typeof c === "string")))) throw new Error("exams.json: an exam's fields have the wrong types");
  }
  return { course: f.course, exams: f.exams as DemoExam[] };
}

/** An exam as the home's input: every field it has is quoted by its one quote; it has no room and no sources list. */
function asHomeInput(e: DemoExam, i: number): HomeExamInput {
  const q = <T>(value: T | null) => ({ value, quote: value === null ? null : e.quote, itemId: null });
  return { id: `demo-exam-${i + 1}`, name: q(e.title), date: q(e.date), location: q<string>(null), topics: q(e.coverage), searched: [] };
}

export interface DemoExamCardModel {
  exam: HomeExam;
  days: number;
  text: string;
  quote: string;
}

/** The next exam with a date that isn't past, on `now` (ISO), or null: no card. */
export function demoExamCard(file: DemoExamsFile, now: string): DemoExamCardModel | null {
  const { countdown } = countdownOf(file.exams.map(asHomeInput), now);
  if (countdown.kind !== "days") return null;
  const i = Number(countdown.exam.id.replace("demo-exam-", "")) - 1;
  return { exam: { ...countdown.exam, dateFrom: "Quoted from the course" }, days: countdown.days, text: countdown.text, quote: file.exams[i].quote };
}
