// Every demo screen has the app header (components/demo/DemoHeader.tsx): the wordmark, the way to each
// lecture's practice and the Course tape, and the bundle's permission label in a slim strip under it.
// With accounts on (NEXT_PUBLIC_REWIND_ACCOUNTS=1) its right side holds the account button; off, it's empty.
// It also caches the demo for offline use.

import { AccountEntry } from "@/components/accounts/AccountEntry";
import { DemoHeader } from "@/components/demo/DemoHeader";
import { DemoOffline } from "@/components/demo/DemoOffline";
import { fakeAuthEnabled } from "@/lib/accounts/fake";
import { accountsEnabled } from "@/lib/accounts/flag";
import { attemptTopic } from "@/lib/attempts/examples";
import { bundleAssets } from "@/lib/demo/bundle";
import { lectureLabel } from "@/lib/demo/lecture-label";
import { defaultSet, loadDemoBundle } from "@/lib/demo/load";

export default async function DemoLayout({ children }: LayoutProps<"/demo">) {
  const bundle = await loadDemoBundle();
  // The bundle's own files (same origin): every slide image and each hosted clip that's there.
  // Plus the header's mark (components/brand/Wordmark.tsx), so the header looks the same offline.
  const assets = bundle ? [...bundleAssets(bundle), "/brand/rewind-mark.svg"] : [];
  // Each lecture's tab: its topic first (from its lecture deck), then its date ("Sorting · Oct 13").
  const sets =
    bundle?.sets.map((s) => {
      const l = lectureLabel(s.seed.questions.map((q) => q.match.slide.deck));
      return { id: s.id, label: s.lecture.replace(/^Lecture, /, ""), topic: l?.topic ?? null, deck: l?.deck ?? null };
    }) ?? [];
  const account =
    bundle && accountsEnabled() ? (
      <AccountEntry
        course={bundle.course.code}
        questions={bundle.sets.flatMap((s) => s.seed.questions).map((q) => ({ id: q.id, topic: attemptTopic(q), stem: q.stem }))}
        fake={fakeAuthEnabled()}
      />
    ) : null;
  return (
    <>
      {/* A banner landmark (header), so no text sits outside a landmark. */}
      <DemoHeader
        course={bundle?.course.code ?? "COP3530"}
        label={bundle?.label ?? "Demo course"}
        sets={sets}
        defaultSet={bundle ? (defaultSet(bundle)?.id ?? null) : null}
        account={account}
      />
      <DemoOffline assets={assets} />
      {/* The screen fills what's left under the header (its own min-h-dvh is relaxed in app/header.css). */}
      <div data-demo-main="" className="demo-main">
        {children}
      </div>
    </>
  );
}
