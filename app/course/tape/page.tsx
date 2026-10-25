// Course tape (docs/design/CourseTape.dc.html): the semester as one cassette tape, stops in course
// order with glow = stressed and ring = missed, tonight's route back, and every stop's evidence.
// Data from lib/course (built on the server from the local private/ data; dev only, like /practice);
// TapeScreen merges in the practice attempts kept in this browser, which never leave the device.

import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { TapeScreen } from "@/components/course/TapeScreen";
import { TapeSkeleton } from "@/components/course/TapeSkeleton";
import { EmptyState } from "@/components/states/EmptyState";
import { exampleSeedOf } from "@/lib/attempts/examples";
import { courseKey } from "@/lib/attempts/store";
import { loadLocalTapeScreen } from "@/lib/course/local";
import { loadLocalSeed } from "@/lib/demo/load";
import { extensionId } from "@/lib/extension";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Course tape");

export default function CourseTapePage() {
  return (
    <Suspense fallback={<TapeSkeleton />}>
      <Tape />
    </Suspense>
  );
}

async function Tape() {
  await connection();
  const data = await loadLocalTapeScreen(new Date().toISOString());
  if (!data) {
    return (
      <EmptyState art="cassette" title="No course data yet" action={{ href: "/demo/practice", label: "Try the demo course" }}>
        Put lecture transcripts or a Canvas export in private/, then reload.
      </EmptyState>
    );
  }
  if (!data.tape.stops.length) {
    return (
      <EmptyState art="cassette" title="No topics on the tape yet" action={{ href: "/course", label: "Back to the course" }}>
        {data.tape.course.code} has no modules or lectures to put on the tape. Put the Canvas export or lecture transcripts in private/, run the course pipeline (npm run pipeline), then reload.
      </EmptyState>
    );
  }
  const seed = await loadLocalSeed();
  const examples = seed && courseKey(seed.course.code) === courseKey(data.tape.course.code) ? exampleSeedOf(seed) : null;
  return <TapeScreen tape={data.tape} clips={data.clips} examples={examples} extensionId={extensionId()} />;
}
