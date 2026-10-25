// A plain reading page on the deck (/extension, /privacy): the wordmark home, a title, a lead line, then sections.

import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/brand/Wordmark";

export function InfoPage({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
      <Link href="/" aria-label="Rewind, home" className="inline-flex min-h-11 items-center self-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label">
        <Wordmark />
      </Link>
      <header className="flex flex-col gap-3">
        <h1 className="m-0 font-display text-[30px] leading-none font-extrabold tracking-[-1px] sm:text-[44px] sm:tracking-[-1.4px]">{title}</h1>
        <p className="m-0 text-[18px] leading-snug text-label-muted">{lead}</p>
      </header>
      {children}
    </main>
  );
}

export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 text-[18px] leading-relaxed">
      <h2 className="m-0 font-display text-[22px] font-bold tracking-[-0.4px]">{title}</h2>
      {children}
    </section>
  );
}

/** A link inside running text: bold, underlined on hover and focus (the design lint's rule for inline links). */
export const INLINE_LINK = "font-bold hover:underline focus-visible:underline underline-offset-2";
