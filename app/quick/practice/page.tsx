// Quick build (beta): practice on the questions stored in this browser. Not found unless NEXT_PUBLIC_REWIND_QUICK_BUILD=1.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { QuickPractice } from "@/components/quick/QuickPractice";
import { pageMetadata } from "@/lib/brand/metadata";
import { extensionId } from "@/lib/extension";
import { quickBuildOn } from "@/lib/quick/flag";

export const metadata: Metadata = pageMetadata("Quick build practice");

export default function QuickPracticePage() {
  if (!quickBuildOn()) notFound();
  return (
    <Suspense fallback={<main className="min-h-dvh" aria-busy="true" />}>
      <QuickPractice extensionId={extensionId()} />
    </Suspense>
  );
}
