// The full-screen study session on the demo course: the bundle's tape and questions, its hosted clips, and the public
// demo tutor (/api/demo/tutor: its own key, limits and saved replies; never graded; always the question's topic rule).
// Static, like the other demo pages. ⤢ on the demo tutor panel opens it with ?q=<question>.

import type { Metadata } from "next";
import { DemoMissing } from "@/components/demo/DemoPlaceholder";
import { StudySession } from "@/components/study/StudySession";
import { loadDemoBundle, loadDemoTape } from "@/lib/demo/load";
import { demoStudyConfig } from "@/lib/study/config";
import { demoMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = demoMetadata();

export default async function DemoStudyPage() {
  const [bundle, tape] = await Promise.all([loadDemoBundle(), loadDemoTape()]);
  if (!bundle || !tape) return <DemoMissing />;
  return <StudySession config={demoStudyConfig(bundle, tape)} />;
}
