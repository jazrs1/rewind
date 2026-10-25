"use client";

// Quick build (beta): /quick/practice. The questions stored on this device, on the Scantron sheet with the grading beat
// (PracticeFlow); after grading the sheet shows the exact quote and where it is from. Without a stored bank: an empty state.

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { RichTextContext } from "@/components/paper/RichText";
import { PracticeFlow } from "@/components/practice/PracticeFlow";
import { mathText } from "./MathText";
import { EmptyState } from "@/components/states/EmptyState";
import { bankToSeed } from "@/lib/quick/seed";
import { browserBanks, type QuickBank } from "@/lib/quick/store";

export function QuickPractice({ extensionId }: { extensionId: string }) {
  const course = useSearchParams().get("course");
  const [bank, setBank] = useState<QuickBank | null | undefined>(undefined);
  useEffect(() => {
    const banks = browserBanks();
    const sync = () => {
      const all = banks.list();
      setBank((course ? all.find((b) => b.course.code === course) : null) ?? all[0] ?? null);
    };
    sync();
    return banks.subscribe(sync);
  }, [course]);
  const seed = useMemo(() => (bank ? bankToSeed(bank) : null), [bank]);

  if (bank === undefined) return <main className="min-h-dvh" aria-busy="true" />;
  if (!seed || !bank) {
    return (
      <EmptyState art="form" title="No questions on this device" action={{ href: "/extension", label: "Build my practice" }}>
        Questions from Quick build are saved in the browser that built them. Build them here first.
      </EmptyState>
    );
  }
  // Course math ("$...$") drawn with KaTeX on this screen only.
  return (
    <RichTextContext.Provider value={mathText}>
      <PracticeFlow key={bank.builtAt} seed={seed} extensionId={extensionId} remote />
    </RichTextContext.Provider>
  );
}
