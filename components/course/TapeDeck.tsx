"use client";

// The desktop course tape (CourseTape mockup): one tape winding from the supply reel (first lecture) to the
// take-up reel (final exam) around guide rollers, sized to the course: rows grow with the stops (two for one
// or two stops, then one per stop up to four; lib/course/tapeLayout.ts). Bright tape up to the tape head
// ("You are here"), dim after. Each stop is a button (at least 44 px) holding its dot in the module's shell
// colour and its name, placed on the free side of the dot (never under the head, its pill, a flag or a route
// badge; a long name ends in an ellipsis, the full name in its tooltip and accessible name). A glow when he
// stressed it, a ring when you miss it, "◀◀ n" when it's on tonight's route back. Positions are frame units
// (one CSS pixel at 740 wide) and scale with the panel.
//
// Motion: the stops fade in along the tape (--stagger-stop apart, --ease-settle), the head runs along the
// ribbon from the first lecture to where the course is now, and when the route back starts it travels back to
// the route's stop before the clip opens. Reduced motion: everything is simply there.

import { MissMark, missCount } from "./MissMark";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { glowLevel, termLabel } from "@/lib/course/geometry";
import { deskFrame, deskLayout, roadPath, roadPoint, roadTotal, rollers, SUPPLY_R, TAKEUP_R, type Box, type TapeFrame } from "@/lib/course/tapeLayout";
import { DUR, easeInOut, prefersReducedMotion } from "@/lib/motion";
import type { CourseTape } from "@/lib/course/types";
import { flagsOf, shellOf, stopName } from "./shared";


function Reel({ big }: { big: boolean }) {
  return (
    <svg viewBox="0 0 120 120" className="h-full w-full" aria-hidden="true">
      <circle cx="60" cy="60" r="58" fill="var(--color-ribbon-core)" />
      {big ? <circle cx="60" cy="60" r="58" fill="var(--color-panel)" fillOpacity="0.5" /> : null}
      {(big ? [50, 42, 33] : [50, 40]).map((r) => (
        <circle key={r} cx="60" cy="60" r={r} fill="none" stroke={big ? "var(--color-reel-groove-dim)" : "var(--color-reel-groove)"} strokeWidth="1.2" />
      ))}
      <circle cx="60" cy="60" r="24" fill="var(--color-label)" />
      <circle cx="60" cy="60" r="13" fill="var(--color-deck)" />
      <g fill="var(--color-label)">
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <rect key={a} x="57" y="44" width="6" height="7" transform={`rotate(${a} 60 60)`} />
        ))}
      </g>
    </svg>
  );
}

/** Everything the deck draws, in frame units (lib/course/tapeLayout.ts deskLayout), from the tape's data. */
function layoutOf(tape: CourseTape, ranks: Map<string, number>, f: TapeFrame) {
  const flags = flagsOf(tape);
  const L = deskLayout(f, {
    stops: tape.stops.map((s) => ({ position: s.position, topic: s.topic, onRoute: !!ranks.get(s.id), misses: missCount(s) })),
    here: tape.here.position,
    week: tape.week?.n ?? null,
    flags: flags.map((fl) => ({ position: fl.m.position!, text: fl.text })),
  });
  return { ...L, flags: L.flags.map((fl, i) => ({ ...fl, id: flags[i].m.id, label: flags[i].m.label, text: flags[i].text, next: flags[i].next })) };
}

/** The head as a transform from its resting place (`rest` along the road), in container units: the panel scales, so cqw keeps it on the ribbon. */
function headOffset(f: TapeFrame, rest: number, d: number): string {
  const p = roadPoint(f, d);
  const end = roadPoint(f, rest);
  return `translate(${(((p.x - end.x) / f.width) * 100).toFixed(3)}cqw, ${(((p.y - end.y) / f.width) * 100).toFixed(3)}cqw)`;
}

/** Runs the head along the ribbon from where it is (`at`) to `to` over --dur-rewind on --ease-in-out; reduced motion jumps. */
function runHead(el: HTMLElement, f: TapeFrame, rest: number, at: { current: number }, to: number, delay: number, raf: { current: number }, done?: () => void) {
  cancelAnimationFrame(raf.current);
  if (prefersReducedMotion()) {
    at.current = to;
    el.style.transform = headOffset(f, rest, to);
    done?.();
    return;
  }
  const from = at.current;
  const t0 = performance.now() + delay;
  const step = (t: number) => {
    const k = Math.min(1, Math.max(0, (t - t0) / DUR.rewind));
    at.current = from + (to - from) * easeInOut(k);
    el.style.transform = headOffset(f, rest, at.current);
    if (k < 1) raf.current = requestAnimationFrame(step);
    else done?.();
  };
  raf.current = requestAnimationFrame(step);
}

export function TapeDeck({
  tape,
  ranks,
  onStop,
  rewindTo = null,
  onArrive,
}: {
  tape: CourseTape;
  ranks: Map<string, number>;
  onStop(id: string): void;
  /** A stop the tape head travels back to (the route back starting); null rests it where the course is now. */
  rewindTo?: string | null;
  /** Called when the head reaches `rewindTo`. */
  onArrive?(): void;
}) {
  const rows = tape.stops.length;
  const f = useMemo(() => deskFrame(rows), [rows]);
  const L = useMemo(() => layoutOf(tape, ranks, f), [tape, ranks, f]);
  const { head, headD } = L;
  const headRef = useRef<HTMLDivElement>(null);
  const at = useRef<number>(0);
  const raf = useRef(0);
  const arrive = useRef(onArrive);
  useEffect(() => {
    arrive.current = onArrive;
  }, [onArrive]);

  // On arrival: from the supply reel to where the course is now, after --dur-2.
  useEffect(() => {
    const el = headRef.current;
    if (headD === null || !el) return;
    at.current = 0;
    runHead(el, f, headD, at, headD, DUR[2], raf);
    const id = raf;
    return () => cancelAnimationFrame(id.current);
  }, [f, headD]);

  // The route back: the head travels back to the route's stop, then the clip opens; afterwards it returns.
  const target = rewindTo ? tape.stops.findIndex((s) => s.id === rewindTo) : -1;
  const targetD = target >= 0 ? f.lead + L.slots[target] * L.len : null;
  const lastTarget = useRef<number | null>(null);
  useEffect(() => {
    if (lastTarget.current === targetD) return;
    lastTarget.current = targetD;
    const el = headRef.current;
    if (headD === null || !el) {
      if (targetD !== null) arrive.current?.();
      return;
    }
    runHead(el, f, headD, at, targetD ?? headD, 0, raf, targetD !== null ? () => arrive.current?.() : undefined);
  }, [f, headD, targetD]);

  const shell = shellOf(tape);
  const W = f.width;
  const H = f.height;
  const px = (x: number) => `${(x / W) * 100}%`;
  const py = (y: number) => `${(y / H) * 100}%`;
  const cq = (n: number) => `${((n / W) * 100).toFixed(3)}cqw`;
  const box = (b: Box): CSSProperties => ({ left: px(b.x), top: py(b.y), width: cq(b.w), height: cq(b.h) });
  const road = roadPath(f);
  const total = roadTotal(f);
  const n = tape.stops.length;

  return (
    <section
      aria-label="Course tape"
      data-tape-in=""
      data-rows={f.rows.length}
      className="tape-deck relative w-full overflow-hidden rounded-2xl [container-type:inline-size]"
      style={{ aspectRatio: `${W} / ${H}` }}
    >
      {[
        [14, 14],
        [W - 28, 14],
        [14, H - 28],
        [W - 28, H - 28],
      ].map(([x, y]) => (
        <div
          key={`${x}-${y}`}
          aria-hidden="true"
          className="absolute flex size-[14px] items-center justify-center rounded-full"
          style={{ left: px(x), top: py(y), background: "radial-gradient(circle at 35% 35%, var(--color-screw), var(--color-tape-blank) 70%)" }}
        >
          <div className="h-[2px] w-[9px] rotate-[35deg] bg-deck" />
        </div>
      ))}
      <div className="absolute flex items-baseline justify-between text-[13px] text-label-muted" style={{ left: px(40), right: px(40), top: py(16) }}>
        <span>
          <b className="text-label">{tape.course.code}</b> · {termLabel(tape.course.name) ? `${termLabel(tape.course.name)}, from` : "From"} the first lecture to the final
        </span>
        <span>{L.weeks ? "Wk = course week" : null}</span>
      </div>

      {tape.stops.map((s, i) => {
        const level = glowLevel(s.stressed.heat, s.stressed.score);
        if (!level) return null;
        const p = L.dots[i];
        const d = 64 + level * 30;
        const a = Math.min(0.9, 0.18 * level + (s.missed.score > 0 ? 0.1 : 0));
        return (
          <div
            key={`glow-${s.id}`}
            aria-hidden="true"
            data-glow={level}
            data-glow-for={s.id}
            className="glow-pulse pointer-events-none absolute rounded-full mix-blend-screen blur-[8px]"
            style={{
              ["--n" as string]: n,
              left: px(p.x - d / 2),
              top: py(p.y - d / 2),
              width: cq(d),
              aspectRatio: "1",
              background: `radial-gradient(closest-side, rgba(255,96,40,${a.toFixed(2)}) 0%, rgba(250,70,22,${(a * 0.6).toFixed(2)}) 35%, rgba(233,180,60,${(a * 0.35).toFixed(2)}) 65%, rgba(233,180,60,0) 100%)`,
            }}
          />
        );
      })}

      {rollers(f).map((r) => {
        const d = 2 * (f.r - 4);
        return (
          <svg key={`${r.x}-${r.y}`} viewBox="0 0 160 160" className="pointer-events-none absolute opacity-60" style={{ left: px(r.x - d / 2), top: py(r.y - d / 2), width: cq(d) }} aria-hidden="true">
            <circle cx="80" cy="80" r="77" fill="var(--color-roller)" stroke="var(--color-roller-rim)" strokeWidth="2.5" />
            <circle cx="80" cy="80" r="52" fill="none" stroke="var(--color-roller-groove)" strokeWidth="1.5" />
            <circle cx="80" cy="80" r="17" fill="var(--color-hub)" />
            <circle cx="76" cy="76" r="9" fill="var(--color-hub-shine)" opacity="0.7" />
            <circle cx="80" cy="80" r="4" fill="var(--color-deck)" />
          </svg>
        );
      })}

      <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        <path d={road} fill="none" stroke="var(--color-shadow)" strokeOpacity="0.38" strokeWidth="20" transform="translate(1.5 4)" />
        <path d={road} fill="none" stroke="var(--color-ribbon-hi)" strokeWidth="16" />
        <path d={road} fill="none" stroke="var(--color-ribbon-core)" strokeWidth="12.5" />
        <path d={road} fill="none" stroke="var(--color-ribbon-sheen)" strokeWidth="5" strokeOpacity="0.55" />
        <path d={road} fill="none" stroke="var(--color-ribbon-edge)" strokeWidth="1" strokeOpacity="0.45" />
        <path d={road} fill="none" stroke="var(--color-panel)" strokeOpacity="0.6" strokeWidth="17" strokeDasharray={headD !== null ? `0 ${headD} ${total + 300}` : `0 ${total + 300}`} />
      </svg>

      <div className="pointer-events-none absolute" style={{ left: px(L.supply.x - SUPPLY_R), top: py(L.supply.y - SUPPLY_R), width: cq(2 * SUPPLY_R) }}>
        <Reel big={false} />
      </div>
      <div className="absolute -translate-x-1/2 text-[13px] font-bold whitespace-nowrap text-label-muted" style={{ left: px(L.supply.x), top: py(L.supply.y + SUPPLY_R + 6) }}>
        First lecture
      </div>
      <div className="pointer-events-none absolute" style={{ left: px(L.takeUp.x - TAKEUP_R), top: py(L.takeUp.y - TAKEUP_R), width: cq(2 * TAKEUP_R) }}>
        <Reel big />
      </div>
      <div className="absolute -translate-x-1/2 text-[13px] font-bold whitespace-nowrap text-label-muted" style={{ left: px(L.takeUp.x), top: py(L.takeUp.y + TAKEUP_R + 6) }}>
        Final exam
      </div>

      {L.counters.map((c) => (
        <div
          key={c.w}
          aria-hidden="true"
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-[3px] border border-tape-blank-label bg-deck px-[5px] py-px font-display text-[11px] font-bold tracking-[1px] text-label-muted tabular-nums"
          style={{ left: px(c.x), top: py(c.y) }}
        >
          Wk {c.w}
        </div>
      ))}

      {tape.stops.map((s, i) => {
        const p = L.dots[i];
        const { label, badge, miss } = L.places[i];
        const lb = L.labels[i];
        const ahead = s.state === "future";
        const rank = ranks.get(s.id);
        const misses = missCount(s);
        // The button covers the dot (44 px) and its label, so both lift together and the name is part of the target.
        const dot = { x: p.x - 22, y: p.y - 22, w: 44, h: 44 };
        const x0 = Math.min(dot.x, label.x - 4);
        const y0 = Math.min(dot.y, label.y - 2);
        const hit = { x: x0, y: y0, w: Math.max(dot.x + dot.w, label.x + label.w + 4) - x0, h: Math.max(dot.y + dot.h, label.y + label.h + 2) - y0 };
        // The miss marker goes where the layout put it (the dot's free side, never over the head or its pill).
        return (
          <div key={s.id} style={{ "--i": i } as CSSProperties}>
            <button
              type="button"
              aria-label={stopName(s, rank)}
              aria-haspopup="dialog"
              title={lb.truncated ? s.topic : undefined}
              data-stop-id={s.id}
              data-order={s.order}
              data-state={s.state}
              data-first-taught={s.firstTaughtAt ?? ""}
              data-label-side={label.side}
              onClick={() => onStop(s.id)}
              className="tape-stop-in tape-lift absolute min-h-11 min-w-11 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-label"
              style={box(hit)}
            >
              <span
                data-dot=""
                className="absolute box-content block size-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-deck"
                style={{ left: cq(p.x - hit.x), top: cq(p.y - hit.y), background: ahead ? "var(--color-tape-blank-label)" : shell(s) }}
              />
              {misses && miss ? (
                <span data-miss-for={s.id} className="absolute flex" style={{ left: cq(miss.x - hit.x), top: cq(miss.y - hit.y), width: cq(miss.w), height: cq(miss.h) }}>
                  <MissMark n={misses} />
                </span>
              ) : null}
              <span
                aria-hidden="true"
                data-stop-label=""
                className={`absolute flex text-[13px] leading-4 font-bold ${label.side === "above" ? "items-end" : label.side === "below" ? "items-start" : "items-center"} ${label.align === "center" ? "justify-center" : label.align === "right" ? "justify-end" : "justify-start"}`}
                style={{
                  left: cq(label.x - hit.x - 2),
                  width: cq(label.w + 4),
                  top: cq(label.side === "above" ? label.y + label.h - 32 - hit.y : label.side === "below" ? label.y - hit.y : label.y + label.h / 2 - 16 - hit.y),
                  height: cq(32),
                  color: ahead ? "var(--color-ahead)" : "var(--color-label)",
                }}
              >
                <span className="tape-clamp" style={{ textAlign: label.align }}>
                  {s.topic}
                </span>
              </span>
            </button>
            {rank && badge ? (
              <div
                aria-hidden="true"
                data-route-badge={rank}
                className="tape-stop-in pointer-events-none absolute flex items-center justify-center gap-1 rounded-[13px] bg-action text-[13px] font-bold whitespace-nowrap text-ink shadow-[0_0_0_3px_var(--color-deck)]"
                style={box(badge)}
              >
                ◀◀ {rank}
              </div>
            ) : null}
          </div>
        );
      })}

      {L.flags.map((fl) => (
        <div
          key={fl.id}
          data-flag={fl.next ? "next" : "past"}
          className={`pointer-events-none absolute flex flex-col ${fl.left ? "-translate-x-full items-end" : "items-start"}`}
          style={{ left: px(fl.left ? fl.p.x + 11 : fl.p.x - 10), top: py(fl.p.y - 58) }}
        >
          <div className={`rounded px-2 py-1 text-[13px] font-bold whitespace-nowrap shadow-[0_2px_6px_rgba(0,0,0,0.45)] ${fl.next ? "bg-label text-deck" : "bg-tape-blank-label text-label"}`}>
            <span aria-hidden="true">{fl.text}</span>
            <span className="sr-only">
              {fl.label}
              {fl.text.includes(" · ") ? ` · ${fl.text.split(" · ").slice(1).join(" · ")}` : ""}
            </span>
          </div>
          <div className={`h-[22px] w-[2px] ${fl.left ? "mr-[10px]" : "ml-[10px]"} ${fl.next ? "bg-label" : "bg-tape-blank-label"}`} />
        </div>
      ))}

      {head && L.bubble ? (
        <>
          <div
            aria-hidden="true"
            data-head=""
            ref={headRef}
            className="pointer-events-none absolute flex items-center justify-center rounded shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
            style={{
              left: px(head.x - 15),
              top: py(head.y - 14),
              width: cq(30),
              height: cq(28),
              // It starts at the supply reel (the first lecture) and runs along the tape to where the course is now.
              transform: headOffset(f, headD!, 0),
              background: "linear-gradient(180deg, var(--color-head-hi) 0%, var(--color-head-mid) 55%, var(--color-head-lo) 100%)",
            }}
          >
            <div className="h-[70%] w-[2px] bg-deck" />
          </div>
          {/* The pill stays inside the panel; its pointer stays over the head. It steps aside while the head is away on the route. */}
          <div data-here="" data-away={rewindTo ? "" : undefined} className="tape-here head-arrive pointer-events-none absolute" style={box(L.bubble)}>
            <div className="flex h-full items-center justify-center rounded-full bg-label text-[13px] font-bold whitespace-nowrap text-deck">{L.bubble.text}</div>
          </div>
          <div
            aria-hidden="true"
            data-away={rewindTo ? "" : undefined}
            className="tape-here head-arrive pointer-events-none absolute h-0 w-0 -translate-x-1/2 border-x-[7px] border-t-[9px] border-x-transparent border-t-label"
            style={{ left: px(head.x), top: py(head.y - 34) }}
          />
        </>
      ) : null}
    </section>
  );
}

