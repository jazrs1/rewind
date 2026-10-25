// The judges' demo: the practice flow on the precomputed demo bundle (the real COP3530 lecture
// practice, used with Professor Kapoor's permission), the latest lecture's set. Hosted clips where
// John has put them; every other clip shows its slide and transcript. No extension, no Zoom, no
// login, no keys.

import type { Metadata } from "next";
import { PracticeFlow } from "@/components/practice/PracticeFlow";
import { practiceTitle } from "@/lib/demo/lecture-label";
import { DemoMissing } from "@/components/demo/DemoPlaceholder";
import { demoTutorConfig } from "@/lib/demo/tutor-config";
import { defaultSet, loadDemoBundle, setMedia } from "@/lib/demo/load";
import { demoMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = demoMetadata();

export default async function DemoPracticePage() {
  const bundle = await loadDemoBundle();
  const set = defaultSet(bundle);
  if (!bundle || !set) return <DemoMissing />;
  // The demo course is one module: its colour (tape 1) runs through the sheet and the player.
  const shells = Object.fromEntries(set.seed.questions.map((q) => [q.id, 1 as const]));
  return <PracticeFlow key={set.id} seed={{ ...set.seed, set: practiceTitle(set.lecture, set.seed.questions.map((q) => q.match.slide.deck)) }} extensionId="" media={setMedia(set)} tutor={demoTutorConfig(bundle)} shells={shells} />;
}
