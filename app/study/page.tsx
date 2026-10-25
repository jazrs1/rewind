// The full-screen study session (components/study/StudySession.tsx) on the local course data, dev only like /practice:
// from "Study with the tutor" on the course home's exam and quiz cards (?exam=<id>), or ⤢ on the tutor panel (?set=…&q=…).
// What counts as graded is decided on the server (lib/study/config.ts → lib/tutor/graded.ts).

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState } from "@/components/states/EmptyState";
import { StudySession } from "@/components/study/StudySession";
import { loadStudyConfig } from "@/lib/study/config";
import { pageMetadata } from "@/lib/brand/metadata";
import { LoadingScreen } from "@/components/brand/LoadingScreen";

export const metadata: Metadata = pageMetadata("Study");

export default function StudyPage({ searchParams }: PageProps<"/study">) {
  return (
    <Suspense fallback={<LoadingScreen data-study="" className="h-dvh" />}>
      <Study searchParams={searchParams} />
    </Suspense>
  );
}

async function Study({ searchParams }: { searchParams: PageProps<"/study">["searchParams"] }) {
  const params = await searchParams;
  // Days to the exam are counted from now, per request.
  await connection();
  const config = await loadStudyConfig({ set: params.set, exam: params.exam });
  if (!config) {
    return (
      <EmptyState art="form" title="No course data for a study session yet" action={{ href: "/demo/study", label: "Try the demo course" }}>
        Put lecture transcripts or a Canvas export in private/, run the course pipeline (npm run pipeline), then reload.
      </EmptyState>
    );
  }
  return <StudySession config={config} />;
}
