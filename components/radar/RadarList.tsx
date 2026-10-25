"use client";

// Lite exam radar: the moments a lecturer flagged ("you should know", "ask in exams"),
// each one his own words with its time, playable in the Rewind player.
// Evidence from the lecture, never a prediction.

import { useEffect, useRef, useState } from "react";
import { RewindPlayer } from "@/components/rewind/RewindPlayer";
import { SourceLabel } from "@/components/source/SourceLabel";
import type { PracticeSeed, RadarMoment } from "@/lib/demo/types";
import { formatTime } from "@/lib/format";

const KIND_LABELS: Record<string, string> = {
  exam: "Exam",
  importance: "Important",
  interview: "Interview question",
  recall: "Callback",
  "common-mistake": "Common mistake",
};

/** The clip: from the flagged line itself (so the caption matches the quote), about 30 s, within the lines we have. */
function clipFor(m: RadarMoment) {
  const lastEnd = Math.max(m.start + 10, ...m.context.map((c) => c.end));
  return { start: m.start, end: Math.min(m.start + 30, lastEnd) };
}

export function RadarList({ seed, extensionId }: { seed: PracticeSeed; extensionId: string }) {
  const moments = seed.radar ?? [];
  const kinds = [...new Set(moments.flatMap((m) => m.kinds))];
  const [kind, setKind] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const shown = kind ? moments.filter((m) => m.kinds.includes(kind)) : moments;
  // Opening a moment closes the one above it; keep the tapped card in view when the page shifts.
  const cards = useRef(new Map<number, HTMLLIElement>());
  useEffect(() => {
    if (open === null) return;
    const el = cards.current.get(open);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => el?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }));
  }, [open]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-5 py-6 text-label lg:px-8 lg:py-10">
      <header className="flex flex-col gap-2">
        <a href="/practice" className="btn btn-tertiary self-start">
          ← Practice
        </a>
        <h1 className="font-display text-4xl font-extrabold tracking-tight lg:text-5xl">Exam radar</h1>
        <p className="text-label-muted">
          {moments.length} moments in {seed.course.code} {seed.lectureTitle ?? "this lecture"} where {seed.lecturer.short} flagged
          something. Word for word, with when each was said: evidence, not a prediction.
        </p>
      </header>

      {moments.length === 0 ? (
        <p className="rounded-xl bg-deck-raised px-4 py-3">
          No flagged moments found in this lecture. The radar looks for phrases like &quot;you should know&quot; or &quot;on the exam&quot;.
        </p>
      ) : (
        <>
          <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-2">
            {[null, ...kinds].map((k) => (
              <button
                key={k ?? "all"}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`min-h-11 rounded-[10px] border-2 px-3.5 text-sm font-bold ${
                  kind === k ? "border-label bg-label text-deck" : "border-deck-line text-label"
                }`}
              >
                {k ? KIND_LABELS[k] ?? k : "All"} ({k ? moments.filter((m) => m.kinds.includes(k)).length : moments.length})
              </button>
            ))}
          </div>

          <ol className="flex flex-col gap-3">
            {shown.map((m) => {
              const isOpen = open === m.start;
              return (
                <li
                  key={m.start}
                  ref={(el) => {
                    if (el) cards.current.set(m.start, el);
                    else cards.current.delete(m.start);
                  }}
                  className="flex scroll-mt-4 flex-col gap-3 rounded-xl bg-deck-raised px-4 py-3.5"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-display text-[22px] leading-none font-extrabold tabular-nums">{formatTime(m.start)}</span>
                    {m.kinds.map((k) => (
                      <span key={k} className="rounded-md bg-deck px-2 py-0.5 text-xs font-bold text-peach">
                        {KIND_LABELS[k] ?? k}
                      </span>
                    ))}
                  </div>
                  <blockquote className="text-base leading-snug">&ldquo;{m.text}&rdquo;</blockquote>
                  <SourceLabel tone="deck">
                    {seed.lecturer.name}, {seed.lectureTitle ?? "lecture"}, {formatTime(m.start)} · matched “{m.phrases.join("”, “")}”
                  </SourceLabel>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={isOpen ? `Close the moment at ${formatTime(m.start)}` : `Play the moment at ${formatTime(m.start)}`}
                    onClick={() => setOpen(isOpen ? null : m.start)}
                    className="btn btn-secondary self-start"
                  >
                    {isOpen ? "Hide this moment" : "Play this moment"}
                  </button>
                  {isOpen ? (
                    <RewindPlayer
                      source={{ kind: "zoom-embed", extensionId, recordingUrl: seed.recordingUrl }}
                      clip={clipFor(m)}
                      segments={m.context}
                      lecturer={seed.lecturer.short}
                      rewoundText={`Rewound to where ${seed.lecturer.short} flagged it`}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </main>
  );
}
