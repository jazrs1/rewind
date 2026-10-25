// The demo course's Course tape, built from the demo bundle only (lib/demo/tape.ts). "Missed" starts
// from example practice history, labelled "Example practice history", until the visitor answers.
// With NEXT_PUBLIC_REWIND_DEMO_EXAMS=1, the next exam's card sits under the route (lib/demo/exam-card.ts);
// off, the exams file isn't read and nothing is added.

import type { Metadata } from "next";
import { TapeScreen } from "@/components/course/TapeScreen";
import { DemoExamSlot } from "@/components/demo/DemoExamCard";
import { DemoMissing } from "@/components/demo/DemoPlaceholder";
import { demoExamsEnabled, parseDemoExams } from "@/lib/demo/exam-card";
import { loadDemoExams, loadDemoTape } from "@/lib/demo/load";
import { demoMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = demoMetadata();

export default async function DemoTapePage() {
  const demo = await loadDemoTape();
  if (!demo) return <DemoMissing />;
  const examsOn = demoExamsEnabled();
  const raw = examsOn ? await loadDemoExams() : null;
  const exams = raw ? parseDemoExams(raw) : null;
  return (
    <TapeScreen
      tape={demo.tape}
      clips={demo.clips}
      examples={demo.examples}
      extensionId=""
      media={demo.media}
      practicePath="/demo/practice/"
      exam={exams ? <DemoExamSlot on={examsOn} file={exams} /> : null}
    />
  );
}
