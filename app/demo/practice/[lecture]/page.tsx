// One lecture's practice set in the demo course (see ../page.tsx), its hosted-clip question first.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PracticeFlow } from "@/components/practice/PracticeFlow";
import { practiceTitle } from "@/lib/demo/lecture-label";
import { DemoMissing } from "@/components/demo/DemoPlaceholder";
import { SheetSkeleton } from "@/components/paper/SheetSkeleton";
import { demoTutorConfig } from "@/lib/demo/tutor-config";
import { loadDemoBundle, setMedia } from "@/lib/demo/load";
import { demoMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = demoMetadata();

export async function generateStaticParams() {
  const bundle = await loadDemoBundle();
  return bundle?.sets.map((s) => ({ lecture: s.id })) ?? [];
}

// params is read inside a Suspense boundary (Cache Components: params outside one blocks the navigation);
// the lectures in generateStaticParams still prerender in full, and the skeleton is the same as /practice's.
export default function DemoLecturePracticePage({ params }: PageProps<"/demo/practice/[lecture]">) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh flex-col bg-deck lg:items-center lg:justify-start lg:px-8">
          <SheetSkeleton />
        </main>
      }
    >
      <DemoLecture params={params} />
    </Suspense>
  );
}

async function DemoLecture({ params }: Pick<PageProps<"/demo/practice/[lecture]">, "params">) {
  const { lecture } = await params;
  const bundle = await loadDemoBundle();
  if (!bundle) return <DemoMissing />;
  const set = bundle.sets.find((s) => s.id === lecture);
  if (!set) notFound();
  return <PracticeFlow key={set.id} seed={{ ...set.seed, set: practiceTitle(set.lecture, set.seed.questions.map((q) => q.match.slide.deck)) }} extensionId="" media={setMedia(set)} tutor={demoTutorConfig(bundle)} />;
}
