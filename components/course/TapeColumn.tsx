// The phone course tape: the same tape wound top to bottom. The supply reel (first lecture) on top,
// the take-up reel (final exam) at the bottom, stops, exam flags and the tape head ("You are here")
// in tape order down a vertical ribbon: bright up to the head, dim after. Each stop is a full-width
// row button (at least 56 px): its dot with glow (stressed) and ring (missed), its name, when it was
// taught, and "◀◀ n" when it's on tonight's route back.

import { MissMark, missCount } from "./MissMark";
import type React from "react";
import { glowLevel, termLabel } from "@/lib/course/geometry";
import type { CourseTape, Stop } from "@/lib/course/types";
import { dayLabel, flagsOf, shellOf, stopName } from "./shared";

type Row = { kind: "stop"; s: Stop; i: number } | { kind: "flag"; id: string; text: string; next: boolean } | { kind: "here" };

function MiniReel({ big }: { big: boolean }) {
  return (
    <svg viewBox="0 0 120 120" className={big ? "size-[72px]" : "size-14"} aria-hidden="true">
      <circle cx="60" cy="60" r={big ? 52 : 40} fill="var(--color-ribbon-core)" />
      <circle cx="60" cy="60" r={big ? 40 : 30} fill="none" stroke="var(--color-reel-groove)" strokeWidth="1.5" />
      <circle cx="60" cy="60" r="20" fill="var(--color-label)" />
      <circle cx="60" cy="60" r="11" fill="var(--color-deck)" />
    </svg>
  );
}

export function TapeColumn({ tape, ranks, onStop }: { tape: CourseTape; ranks: Map<string, number>; onStop(id: string): void }) {
  const shell = shellOf(tape);
  const here = tape.here.position;
  const rows: { at: number; row: Row }[] = [
    ...tape.stops.map((s, i) => ({ at: s.position, row: { kind: "stop", s, i } as Row })),
    ...flagsOf(tape).map((f) => ({ at: f.m.position! - 0.0001, row: { kind: "flag", id: f.m.id, text: f.text, next: f.next } as Row })),
    ...(here !== null ? [{ at: here + 0.00005, row: { kind: "here" } as Row }] : []),
  ].sort((a, b) => a.at - b.at);
  const headIdx = rows.findIndex((r) => r.row.kind === "here");
  const bright = (i: number) => (headIdx < 0 ? tape.stops.some((s) => s.state !== "future") : i <= headIdx);

  return (
    <section aria-label="Course tape" className="relative rounded-xl px-3 py-4" style={{ background: "radial-gradient(ellipse at 50% 30%, var(--color-panel-hi) 0%, var(--color-panel) 60%, var(--color-panel-lo) 100%)" }}>
      <p className="m-0 mb-2 px-1 text-[13px] text-label-muted">
        <b className="text-label">{tape.course.code}</b>
        {termLabel(tape.course.name) ? ` · ${termLabel(tape.course.name)}` : ""} · first lecture to final
      </p>
      <div className="flex items-center gap-3 pl-[18px]">
        <MiniReel big={false} />
        <span className="text-[13px] font-bold text-label-muted">First lecture</span>
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {rows.map(({ row }, i) => {
          const ribbon = (
            <span aria-hidden="true" className="absolute top-0 bottom-0 left-[38px] w-4" style={{ background: "var(--color-ribbon-core)", boxShadow: "inset 2px 0 0 var(--color-ribbon-hi), inset -2px 0 0 var(--color-ribbon-hi)" }}>
              {!bright(i) ? <span className="absolute inset-0" style={{ background: "var(--color-panel)", opacity: 0.6 }} /> : null}
            </span>
          );
          if (row.kind === "here") {
            return (
              <li key="here" data-here="" className="relative flex min-h-11 items-center">
                {ribbon}
                <span
                  aria-hidden="true"
                  className="relative z-10 ml-[31px] flex h-[22px] w-[30px] items-center justify-center rounded shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
                  style={{ background: "linear-gradient(180deg, var(--color-head-hi) 0%, var(--color-head-mid) 55%, var(--color-head-lo) 100%)" }}
                >
                  <span className="h-4 w-[2px] bg-deck" />
                </span>
                <span className="ml-4 rounded-full bg-label px-[10px] py-1 text-[13px] font-bold text-deck">You are here{tape.week ? ` · Week ${tape.week.n}` : ""}</span>
              </li>
            );
          }
          if (row.kind === "flag") {
            return (
              <li key={row.id} data-flag={row.next ? "next" : "past"} className="relative flex min-h-9 items-center">
                {ribbon}
                <span className={`ml-[84px] rounded px-2 py-1 text-[13px] font-bold ${row.next ? "bg-label text-deck" : "bg-tape-blank-label text-label"}`}>{row.text}</span>
              </li>
            );
          }
          const s = row.s;
          const ahead = s.state === "future";
          const level = glowLevel(s.stressed.heat, s.stressed.score);
          const d = 28 + level * 12;
          const a = Math.min(0.9, 0.18 * level + (s.missed.score > 0 ? 0.1 : 0));
          const rank = ranks.get(s.id);
          return (
            <li key={s.id} className="relative" style={{ "--i": i } as React.CSSProperties}>
              {ribbon}
              <button
                type="button"
                aria-label={stopName(s, rank)}
                aria-haspopup="dialog"
                data-stop-id={s.id}
                data-order={s.order}
                data-state={s.state}
                data-first-taught={s.firstTaughtAt ?? ""}
                onClick={() => onStop(s.id)}
                className="tape-stop-in tape-lift relative flex min-h-14 w-full items-center gap-3 rounded-lg py-2 pr-2 text-left focus-visible:outline-2 focus-visible:outline-label"
              >
                <span className="relative flex w-[92px] flex-none items-center justify-center">
                  {level ? (
                    <span
                      aria-hidden="true"
                      data-glow={level}
                      data-glow-for={s.id}
                      className="pointer-events-none absolute rounded-full mix-blend-screen blur-[6px]"
                      style={{ width: d, height: d, left: 46 - d / 2, background: `radial-gradient(closest-side, rgba(255,96,40,${a.toFixed(2)}) 0%, rgba(250,70,22,${(a * 0.6).toFixed(2)}) 35%, rgba(233,180,60,${(a * 0.35).toFixed(2)}) 65%, rgba(233,180,60,0) 100%)` }}
                    />
                  ) : null}
                  <span
                    data-dot=""
                    className="relative box-content block size-[14px] rounded-full border-[3px] border-deck"
                    style={{ background: ahead ? "var(--color-tape-blank-label)" : shell(s) }}
                  />
                  <MissMark n={missCount(s)} className="absolute bottom-[calc(50%+4px)] left-[53px]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`text-[15px] leading-tight font-bold ${ahead ? "text-ahead" : "text-label"}`}>{s.topic}</span>{" "}
                  <span className="text-[13px] text-label-muted">{s.firstTaughtAt ? `Taught ${dayLabel(s.firstTaughtAt)}` : "Taught: not found"}</span>
                </span>
                {/* Room for the route badge, which sits beside the button (outside it, so the button's name is its own text). */}
                {rank ? <span aria-hidden="true" className="w-[52px] flex-none" /> : null}
              </button>
              {rank ? (
                <span aria-hidden="true" data-route-badge={rank} className="tape-stop-in pointer-events-none absolute top-[calc(50%-13px)] right-2 flex h-[26px] items-center gap-1 rounded-[13px] bg-action px-2 text-[13px] font-bold whitespace-nowrap text-ink">
                  ◀◀ {rank}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-3 pl-[10px]">
        <MiniReel big />
        <span className="text-[13px] font-bold text-label-muted">Final exam</span>
      </div>
    </section>
  );
}
