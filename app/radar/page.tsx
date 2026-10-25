import type { Metadata } from "next";
import { Suspense } from "react";
import { RadarList } from "@/components/radar/RadarList";
import { RadarSkeleton } from "@/components/radar/RadarSkeleton";
import { loadLocalSeed } from "@/lib/demo/load";
import { extensionId } from "@/lib/extension";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Exam radar");

export default function RadarPage() {
  return (
    <Suspense fallback={<RadarSkeleton />}>
      <Radar />
    </Suspense>
  );
}

async function Radar() {
  const seed = await loadLocalSeed();
  if (!seed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-3 px-5">
        <h1 className="font-display text-3xl font-extrabold">No lecture scanned yet</h1>
        <p className="text-label-muted">
          Run <code>npm run spike:seed</code> to scan the lecture, then reload.
        </p>
      </main>
    );
  }
  return <RadarList seed={seed} extensionId={extensionId()} />;
}
