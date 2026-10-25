// Where a claim comes from, as part of the product rather than a browser-default link: a small label row
// ("Slide 84 · Sets, Maps & Hash Tables") with, at its right end, a quiet text button that opens the source
// ("Open in Canvas ↗"), underlined on hover only, with a 44 px tap target. One style everywhere a source
// is shown: under the slide frame, under a setup line, on the practice sheet, on radar evidence. Two
// worlds: "deck" (label-muted on the deck, peach link) and "paper" (print green, the paper link colour).

import type { ReactNode } from "react";
import { ExternalLink } from "@/components/icons";

export type SourceTone = "deck" | "paper";

const TONES: Record<SourceTone, { text: string; link: string }> = {
  deck: { text: "text-label-muted", link: "text-peach decoration-peach/60 focus-visible:outline-label" },
  paper: { text: "text-print", link: "text-paper-link decoration-paper-link-line focus-visible:outline-print" },
};

export function OpenIcon() {
  return <ExternalLink size={16} />;
}

export interface SourceLabelProps {
  tone: SourceTone;
  /** What the source is, e.g. "Slide 84 · Sets, Maps & Hash Tables". */
  children: ReactNode;
  /** Opens the source in a new tab, e.g. { href: canvasUrl, label: "Open in Canvas" }. */
  link?: { href: string; label: string } | null;
  /** Printed like a form footer ("Source: Slide 1 · Demo deck", small caps, no link): the practice sheet while asking. */
  printed?: boolean;
  /** One line, cut with an ellipsis when it's too long (the whole text is its tooltip): the label under the slide. Its
   *  row is as tall as its text; the link keeps its 44 px target by overlapping the gaps around it (the caller's margins). */
  oneLine?: boolean;
  className?: string;
}

export function SourceLabel({ tone, children, link, printed = false, oneLine = false, className = "" }: SourceLabelProps) {
  const t = TONES[tone];
  return (
    <div data-source="" className={`flex items-center justify-between gap-3 font-sans text-[13px] leading-snug ${link && !oneLine ? "min-h-11" : printed ? "min-h-9" : ""} ${className}`}>
      <span
        title={oneLine && typeof children === "string" ? children : undefined}
        className={`min-w-0 ${oneLine ? "truncate" : ""} ${t.text} ${printed ? "font-bold tracking-[0.08em] uppercase" : ""}`}
      >
        {printed ? <>Source: {children}</> : children}
      </span>
      {link ? (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="btn btn-tertiary -mr-2 flex-none text-[15px]"
        >
          {link.label}
          <OpenIcon />
        </a>
      ) : null}
    </div>
  );
}
