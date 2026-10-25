// The Ask tab (components/ask/AskChat.tsx) over every course imported on this device: the local course data, dev
// only like /practice and /study; ?set=e2e-ask is the invented two-course set the e2e tests use. The tools run in the
// browser over this data; /api/ask holds the prompt and makes the model call, and stores nothing. A 404 outside
// `next dev` (lib/ask/dev-only.test.ts); lib/ask/local.ts is server-only.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { AskChat } from "@/components/ask/AskChat";
import { EmptyState } from "@/components/states/EmptyState";
import { examplesFor } from "@/lib/ask/examples";
import { loadAskCourses } from "@/lib/ask/local";
import { isDemoMode } from "@/lib/demo/guard";

export const metadata: Metadata = { title: "Ask · Rewind" };

export default function AskPage({ searchParams }: PageProps<"/ask">) {
  // Dev only: a production or demo build answers 404 here (its local course data never leaves the dev machine).
  if (process.env.NODE_ENV !== "development" || isDemoMode()) notFound();
  return (
    <Suspense fallback={<main data-ask="" aria-busy="true" className="h-dvh bg-tutor" />}>
      <Ask searchParams={searchParams} />
    </Suspense>
  );
}

async function Ask({ searchParams }: { searchParams: PageProps<"/ask">["searchParams"] }) {
  const params = await searchParams;
  // Days left are counted from now, per request.
  await connection();
  const courses = await loadAskCourses(typeof params.set === "string" ? params.set : undefined);
  if (!courses?.length) {
    return (
      <EmptyState art="form" title="No courses on this device yet" action={{ href: "/demo/ask", label: "Try the demo course" }}>
        Put a Canvas export or lecture transcripts in private/, run the course pipeline (npm run pipeline), then reload.
      </EmptyState>
    );
  }
  return <AskChat courses={courses} endpoint="/api/ask" demo={false} examples={examplesFor(courses)} saved={[]} title="Ask" />;
}
