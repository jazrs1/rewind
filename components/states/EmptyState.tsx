// Empty states (E7): a small drawing in the app's two worlds (an empty shelf and a blank cassette on the deck, an
// unprinted form on paper), one line saying what to do next, and one button.

import Link from "next/link";
import type { ReactNode } from "react";

export type EmptyArt = "shelf" | "cassette" | "form";

function Art({ art }: { art: EmptyArt }) {
  const line = { fill: "none", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg width="160" height="104" viewBox="0 0 160 104" aria-hidden="true" data-empty-art={art} className="flex-none">
      {art === "shelf" ? (
        <g {...line} stroke="var(--color-deck-line)">
          <path d="M10 80h140" strokeWidth="4" />
          <path d="M22 80v14M138 80v14" />
          <path d="M34 80V52h22v28M64 80V40h22v40" strokeDasharray="3 6" />
          <rect x="96" y="56" width="26" height="24" rx="3" strokeDasharray="3 6" />
        </g>
      ) : art === "cassette" ? (
        <g {...line} stroke="var(--color-deck-line)">
          <rect x="18" y="14" width="124" height="76" rx="8" fill="var(--color-tape-blank)" />
          <rect x="34" y="26" width="92" height="30" rx="4" fill="var(--color-tape-blank-label)" />
          <circle cx="24" cy="22" r="2.5" />
          <circle cx="136" cy="22" r="2.5" />
          <path d="M54 72h52M54 72l-8 12M106 72l8 12" />
          <circle cx="60" cy="72" r="6" />
          <circle cx="100" cy="72" r="6" />
        </g>
      ) : (
        <g {...line} stroke="var(--color-print)">
          <rect x="30" y="6" width="100" height="92" rx="4" fill="var(--color-paper)" stroke="none" />
          <path d="M42 24h44M42 40h76M42 54h76M42 68h50" stroke="var(--color-paper-rule)" strokeDasharray="2 5" />
          {[0, 1, 2].map((i) => (
            <rect key={i} x={42 + i * 28} y="76" width="22" height="12" rx="6" strokeDasharray="2 4" />
          ))}
          <path d="M34 10h8M34 10v8M126 10h-8M126 10v8M34 94h8M34 94v-8M126 94h-8M126 94v-8" />
        </g>
      )}
    </svg>
  );
}

export function EmptyState({ art, title, children, action }: { art: EmptyArt; title: string; children: ReactNode; action: { href: string; label: string } }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-start justify-center gap-4 px-5">
      <Art art={art} />
      <h1 className="font-display text-[40px] leading-none font-extrabold tracking-[-1.2px]">{title}</h1>
      <p className="m-0 text-[17px] leading-snug text-label-muted">{children}</p>
      <Link href={action.href} className="btn btn-primary btn-lg">
        {action.label}
      </Link>
    </main>
  );
}
