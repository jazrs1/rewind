import type { Metadata } from "next";
import { Suspense } from "react";
import { PracticeDataFooter } from "@/components/attempts/PracticeData";
import { SheetSkeleton } from "@/components/paper/SheetSkeleton";
import { PracticeFlow } from "@/components/practice/PracticeFlow";
import { EmptyState } from "@/components/states/EmptyState";
import { exampleSeedOf } from "@/lib/attempts/examples";
import { extensionId } from "@/lib/extension";
import { loadLocalHome, loadLocalPracticeIndex } from "@/lib/home/local";
import { parseLectures, parseModules, practiceSelection, scopedSet } from "@/lib/home/practice";
import { loadPracticeSeed } from "@/lib/pipeline/practice-seed";
import { loadTutorConfig } from "@/lib/tutor/config";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Practice");

export default function PracticePage({ searchParams }: PageProps<"/practice">) {
  return (
    <Suspense fallback={<main className="flex min-h-dvh flex-col bg-deck lg:items-center lg:justify-start lg:px-8"><SheetSkeleton /></main>}>
      <Practice searchParams={searchParams} />
    </Suspense>
  );
}

async function Practice({ searchParams }: { searchParams: PageProps<"/practice">["searchParams"] }) {
  // The course pipeline's practice set (dev only) when a run has finished, else the local seed;
  // ?set=seed always shows the local seed (the e2e tests pin it).
  const params = await searchParams;
  const seed = await loadPracticeSeed(params.set);
  if (!seed) {
    return (
      <EmptyState art="form" title="No practice set yet" action={{ href: "/demo/practice", label: "Try the demo course" }}>
        Run <code>npm run spike:seed</code> to build one from the spike, then reload.
      </EmptyState>
    );
  }
  if (!seed.questions.length) {
    return (
      <EmptyState art="form" title="No questions in this practice set" action={{ href: "/demo/practice", label: "Try the demo course" }}>
        The set for {seed.course.code} is there but has no questions. Run the course pipeline again (npm run pipeline), then reload.
      </EmptyState>
    );
  }
  // ?modules=9,10 or ?lecture=2026-10-22 (from the course home): only those questions, with a line saying so.
  const query = { modules: parseModules(params.modules), lectures: parseLectures(params.lecture) };
  const selection = query.modules || query.lectures ? practiceSelection(await loadLocalPracticeIndex(seed.course.code, seed), query) : null;
  if (selection && !selection.ids.length) {
    return (
      <EmptyState art="form" title="No questions yet" action={{ href: "/course", label: "Back to the course" }}>
        <span data-practice-scope="">{selection.line}</span>
      </EmptyState>
    );
  }
  // A scoped set is numbered within itself ("Question 2 of 5"), not by its place in the full set.
  const shown = scopedSet(seed, selection ? selection.ids : null);
  // E5: each question's module as its tape colour (1..4, the shelf's order), so the sheet and the rewind carry it.
  const [index, home] = await Promise.all([loadLocalPracticeIndex(seed.course.code, seed), loadLocalHome(new Date().toISOString(), seed.course.code)]);
  const shellOfModule = new Map((home?.tapes ?? []).map((t) => [t.position, t.shell]));
  const shells: Record<string, 1 | 2 | 3 | 4 | null> = Object.fromEntries(index.map((q) => [q.id, q.module === null ? null : (shellOfModule.get(q.module) ?? null)]));
  return (
    <>
      {selection ? (
        <header>
          <p data-practice-scope="" className="m-0 bg-deck-raised px-5 py-2 text-center text-[14px] text-label-muted">
            Practising <span className="font-bold text-label">{selection.line}</span>
          </p>
        </header>
      ) : null}
      <PracticeFlow seed={shown} extensionId={extensionId()} shells={shells} tutor={(await loadTutorConfig(shown, params)) ?? undefined} />
      <PracticeDataFooter course={seed.course.code} examples={exampleSeedOf(seed)} />
    </>
  );
}
