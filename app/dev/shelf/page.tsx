// Dev only: the course home's lecture-tape shelf on invented fixture data (no course text), to see the
// cassettes without a private/ export. A 404 in any build.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TapeShelf } from "@/components/home/TapeShelf";
import type { HomeTape } from "@/lib/home/types";
import { pageMetadata } from "@/lib/brand/metadata";

export const metadata: Metadata = pageMetadata("Shelf fixture");

const tape = (position: number, label: string, rest: Partial<HomeTape> = {}): HomeTape => ({
  moduleId: `fixture-${position}`,
  position,
  label,
  state: "blank",
  shell: null,
  lectureDates: [],
  link: null,
  onNextExam: null,
  ...rest,
});

/** Invented modules: two blank in a row (folded on desktop), recorded ones in the four shell colours, a long title. */
const TAPES: HomeTape[] = [
  tape(1, "Mod 1: Getting Started"),
  tape(2, "Mod 2: Counting Things"),
  tape(3, "Mod 3: Lists of Items", { state: "recorded", shell: 1, lectureDates: ["2026-09-08"], link: { href: "#fixture-3", label: "Practice the Sep 8 lecture", note: null } }),
  tape(4, "Mod 4: Ordering and Choosing Between Many Similar Options", {
    state: "recorded",
    shell: 2,
    lectureDates: ["2026-09-15", "2026-09-17"],
    link: { href: "#fixture-4", label: "Practice the Sep 17 lecture", note: "Sep 15: no questions yet" },
  }),
  tape(5, "Mod 5: Lookups", { state: "recorded", shell: 3, lectureDates: ["2026-09-22"], link: { href: "#fixture-5", label: "Open the course tape", note: null }, onNextExam: true }),
  tape(6, "Mod 6: Networks"),
  tape(7, "Mod 7: Shortest Ways", { state: "recorded", shell: 4, lectureDates: ["2026-10-06"], link: null }),
];

export default function ShelfFixturePage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-5 pt-[22px] pb-10 lg:max-w-[880px] lg:gap-[14px] lg:px-12 lg:py-9">
      <section aria-labelledby="tapes-title" className="flex min-w-0 flex-col gap-4 lg:gap-[14px]">
        <TapeShelf tapes={TAPES} latestRecorded={6} examTitle="Exam 2" />
      </section>
    </main>
  );
}
