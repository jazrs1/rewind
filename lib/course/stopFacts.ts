// The Course tape stop sheet's two tiles, in words (John, Oct 25): each title is the fact, never a claim the tile
// could contradict. Pure, so every case is unit-tested (lib/course/stopFacts.test.ts); StopDetails renders them.

import { formatTime } from "../format.ts";
import type { Evidence, Stop } from "./types.ts";

/** "Oct 22" from YYYY-MM-DD. */
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Flag kinds, strongest first: the one a tile names. */
const FLAG_ORDER = ["exam", "importance"];

/**
 * The left tile. A flag names who flagged it, then what and when ("Exam flag · Oct 22, 38:10"); other evidence says
 * what it is; none says "Not flagged yet", with no line under it.
 */
export function stressedFact(stop: Pick<Stop, "stressed" | "lectureMinutes">, prof: string): { title: string; value: string | null } {
  const ev = stop.stressed.evidence;
  const flags = ev.filter((e) => e.kind === "radar");
  if (flags.length) {
    const rank = (e: Evidence) => Math.min(...(e.flags ?? []).map((k) => (FLAG_ORDER.includes(k) ? FLAG_ORDER.indexOf(k) : FLAG_ORDER.length)), FLAG_ORDER.length);
    const top = [...flags].sort((a, b) => rank(a) - rank(b))[0];
    const kind = [...(top.flags ?? [])].sort((a, b) => (FLAG_ORDER.includes(a) ? FLAG_ORDER.indexOf(a) : 9) - (FLAG_ORDER.includes(b) ? FLAG_ORDER.indexOf(b) : 9))[0];
    const when = [top.at ? day(top.at) : null, top.sec != null ? formatTime(top.sec) : null].filter(Boolean).join(", ");
    const value = [kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} flag` : "Flagged in lecture", when].filter(Boolean).join(" · ");
    return { title: `${prof} flagged it`, value: flags.length > 1 ? `${value} (+${flags.length - 1} more)` : value };
  }
  const review = ev.find((e) => e.kind === "review");
  if (review) return { title: "On a past review", value: review.source };
  const note = ev.find((e) => e.kind === "announcement");
  if (note) return { title: "In an announcement", value: note.at ? day(note.at) : null };
  // Lecture minutes count only when they are evidence (a tape of clip excerpts glows from flags and reviews only).
  if (ev.some((e) => e.kind === "minutes") && stop.lectureMinutes > 0) return { title: `${Math.round(stop.lectureMinutes)} min of lecture on it`, value: null };
  return { title: "Not flagged yet", value: null };
}

/** The right tile: "You miss it" over "2 of 3"; no misses yet, or nothing answered, said as the title. */
export function missedFact(misses: number, answered: number): { title: string; value: string | null } {
  if (!answered) return { title: "Not practiced yet", value: null };
  return { title: misses ? "You miss it" : "No misses yet", value: `${misses} of ${answered}` };
}
