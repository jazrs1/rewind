"use client";

// The demo course's next exam (behind NEXT_PUBLIC_REWIND_DEMO_EXAMS, lib/demo/exam-card.ts): the course home's
// ExamCard with its countdown, Date and Covers, and the one quote they come from. The demo pages are prerendered, so
// the days left are counted in the visitor's browser on today's date; before that (and on the server) it renders
// nothing rather than a count from the build's day.

import { useSyncExternalStore } from "react";
import { ExamCard } from "@/components/home/ExamCard";
import { demoExamCard } from "@/lib/demo/exam-card";
import type { DemoExamsFile } from "@/lib/demo/exams";

const noopSubscribe = () => () => {};
/** Today in the browser, to the minute (a stable snapshot between renders). */
const nowSnapshot = () => `${new Date().toISOString().slice(0, 16)}:00.000Z`;

export function DemoExamCard({ file, now = null }: { file: DemoExamsFile; /** The time to count from on the server (tests). */ now?: string | null }) {
  const at = useSyncExternalStore(noopSubscribe, nowSnapshot, () => now);
  const card = at ? demoExamCard(file, at) : null;
  if (!card) return null;
  return (
    <div data-demo-exam="" className="flex flex-col">
      <ExamCard kind="exam" exam={card.exam} days={card.days} text={card.text} idSuffix="demo" second="covers" quote={card.quote} />
    </div>
  );
}

/** The tape page's exam slot: nothing at all when the flag is off or the file isn't there. */
export function DemoExamSlot({ on, file, now = null }: { on: boolean; file: DemoExamsFile | null; now?: string | null }) {
  if (!on || !file) return null;
  return <DemoExamCard file={file} now={now} />;
}
