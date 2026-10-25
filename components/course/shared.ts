// Small helpers shared by the course tape's pieces (TapeDeck, TapeColumn, StopDialog, RoutePlayer).

import { easternDate } from "@/lib/course/build";
import { scoreText } from "@/lib/course/geometry";
import { formatTime } from "@/lib/format";
import type { Clip, CourseTape, Evidence, Marker, Stop } from "@/lib/course/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 22" from YYYY-MM-DD. */
export function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** The tape counter's mm:ss ("06:40"); h:mm:ss past an hour. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s >= 3600) return formatTime(s);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** A stop's accessible name: "Hash tables, stressed 7, missed 2, on the next exam". */
export function stopName(s: Stop, rank: number | undefined): string {
  // The same values the glow and ring are drawn from (scoreText never says 0 for a score above 0).
  // It starts with what the stop shows (topic, when it was taught), so the name contains the visible text.
  const parts = [s.topic, s.firstTaughtAt ? `Taught ${dayLabel(s.firstTaughtAt)}` : "Taught: not found", `stressed ${scoreText(s.stressed.score)}`, `missed ${scoreText(s.missed.score)}`];
  if (s.onNextExam === true) parts.push("on the next exam");
  if (rank) parts.push(`stop ${rank} on tonight's route back`);
  return parts.join(", ");
}

/** Tape shell colour per module, in course order (tape-1..4); slides-only stops get the label-muted dot. */
export function shellOf(tape: CourseTape): (s: Stop) => string {
  const order = [...new Set(tape.stops.filter((s) => s.module).sort((a, b) => a.module!.position - b.module!.position).map((s) => s.module!.id))];
  return (s) => (s.module ? `var(--color-tape-${(order.indexOf(s.module.id) % 4) + 1})` : "var(--color-label-muted)");
}

/** "Oct 22 · 57:43" for a clip, or the lecture date alone, or "date not found". */
export function clipWhen(c: Clip): string {
  return `${c.lectureDate ? dayLabel(c.lectureDate) : "date not found"} · ${formatTime(c.start)}`;
}

/** Where a piece of evidence came from, in small print: "Lecture, Oct 22 · Oct 22 · 57:43". */
export function evidenceSource(e: Evidence): { text: string; link: { href: string; label: string } | null } {
  const bits = [e.source];
  if (e.at && !e.source.includes(dayLabel(e.at))) bits.push(dayLabel(e.at));
  if (e.sec !== undefined) bits.push(formatTime(e.sec));
  const lecture = e.kind === "minutes" || e.kind === "radar";
  return { text: bits.join(" · "), link: e.href ? { href: e.href, label: lecture ? "Open in Zoom" : "Open in Canvas" } : null };
}

/** Flags on the tape: the next exam or quiz, and past exams with their score. Placed ones only. */
export function flagsOf(tape: CourseTape): { m: Marker; text: string; next: boolean }[] {
  const today = easternDate(tape.now) ?? tape.now.slice(0, 10);
  // "Exam 1: Fall 2026 - In Class (...)" → "Exam 1" on the tape; the flag keeps the full name for screen readers.
  const short = (label: string) => label.split(/\s*[:(]\s*|\s+-\s+/)[0].trim() || label;
  return tape.markers
    .filter((m) => m.position !== null && (m.isNext || /\b(exam|midterm)\b/i.test(m.label)))
    .map((m) => {
      if (m.isNext && m.at) {
        const days = Math.round((Date.parse(`${m.at}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
        return { m, next: true, text: `${short(m.label)} · ${days <= 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}` };
      }
      const pct = m.score !== null && m.possible ? ` · ${Math.round((m.score / m.possible) * 100)}%` : "";
      return { m, next: m.isNext, text: `${short(m.label)}${pct}` };
    });
}

export const hasExample = (s: Stop) => s.missed.evidence.some((e) => e.example);
