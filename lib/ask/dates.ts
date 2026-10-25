// Dates for the Ask tab, always in America/New_York and always from the real clock: the model never computes a date.
// list_deadlines takes a range as words ("today", "+14d", "end_of_month"), and this file turns them into Eastern
// calendar days. A calendar date the model writes itself (2026-11-03) is used only when the student's own message names
// that day ("Nov 3", "11/3") or that month ("in November"), so a date the model worked out is refused.

export const TZ = "America/New_York";
const DAY_MS = 86_400_000;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parts = (ms: number) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
};
const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The Eastern calendar day ("YYYY-MM-DD") an instant falls on. A bare day is already one. */
export function easternDay(value: string | number | Date): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const p = parts(ms);
  return dayOf(p.y, p.m, p.d);
}

/** The instant an Eastern day starts (its midnight, EDT or EST as that day has it). */
export function easternStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  // Midnight is 04:00Z in EDT and 05:00Z in EST; the clocks change at 2 am, so exactly one of them is that day's midnight.
  for (const h of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, h);
    const p = parts(t);
    if (p.d === d && p.h === 0 && p.min === 0) return t;
  }
  return Date.UTC(y, m - 1, d, 5);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dayOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** "Oct 24". */
export function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${SHORT[m - 1]} ${d}`;
}

/** "Sat, Oct 24". */
export function weekdayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd}, ${dayLabel(day)}`;
}

/** "11:59 pm" for a timed instant, in Eastern time. */
export function timeLabel(iso: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const { h, min } = parts(ms);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${min ? `:${pad(min)}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** "today", "tomorrow", "in 6 days", "2 days ago". */
export function daysLeftLabel(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The days the student's own words name: "Nov 3", "November 3rd", "11/3", and whole months ("in November"). */
export function namedInText(text: string, today: string): { days: Set<string>; months: Set<number> } {
  const t = text.toLowerCase();
  const year = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  // A month earlier than this one is next year's ("in January", asked in October).
  const yearOf = (m: number) => (m < thisMonth - 1 ? year + 1 : year);
  const days = new Set<string>();
  const months = new Set<number>();
  for (const [i, name] of MONTHS.entries()) {
    const re = new RegExp(`\\b(?:${name}|${name.slice(0, 3)})\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b)?`, "g");
    for (const m of t.matchAll(re)) {
      if (name === "may" && !m[1]) continue; // "may" alone is a verb
      if (m[1]) {
        const d = Number(m[1]);
        if (d >= 1 && d <= lastOfMonth(yearOf(i + 1), i + 1)) days.add(dayOf(yearOf(i + 1), i + 1, d));
      } else months.add(i + 1);
    }
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo < 1 || mo > 12) continue;
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearOf(mo);
    if (d >= 1 && d <= lastOfMonth(y, mo)) days.add(dayOf(y, mo, d));
  }
  return { days, months };
}

export interface DayRange {
  from: string;
  to: string;
  /** "Oct 24 – Nov 7". */
  label: string;
}

/**
 * One end of a range, as list_deadlines takes it: "today", "tomorrow", "+Nd", "+Nw", "-Nd", "end_of_week" (Sunday),
 * "end_of_next_week", "end_of_month", "start_of_next_month", "end_of_next_month", or a YYYY-MM-DD the student named.
 */
export function resolveDay(token: string, today: string, studentText: string): { day: string } | { error: string } {
  const t = token.trim().toLowerCase().replace(/\s+/g, "_");
  const [y, m] = today.split("-").map(Number);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const rel = t.match(/^([+-])(\d{1,3})([dw])$/);
  if (rel) return { day: addDays(today, (rel[1] === "-" ? -1 : 1) * Number(rel[2]) * (rel[3] === "w" ? 7 : 1)) };
  switch (t) {
    case "":
    case "today":
    case "now":
      return { day: today };
    case "tomorrow":
      return { day: addDays(today, 1) };
    case "yesterday":
      return { day: addDays(today, -1) };
    case "end_of_week":
      return { day: addDays(today, (7 - weekday) % 7) };
    case "start_of_next_week":
      return { day: addDays(today, ((7 - weekday) % 7) + 1) };
    case "end_of_next_week":
      return { day: addDays(today, ((7 - weekday) % 7) + 7) };
    case "end_of_month":
      return { day: dayOf(y, m, lastOfMonth(y, m)) };
    case "start_of_next_month":
      return { day: m === 12 ? dayOf(y + 1, 1, 1) : dayOf(y, m + 1, 1) };
    case "end_of_next_month": {
      const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
      return { day: dayOf(ny, nm, lastOfMonth(ny, nm)) };
    }
  }
  const abs = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (abs) {
    const named = namedInText(studentText, today);
    const [ay, am, ad] = [Number(abs[1]), Number(abs[2]), Number(abs[3])];
    const monthEdge = named.months.has(am) && (ad === 1 || ad === lastOfMonth(ay, am));
    if (named.days.has(t) || monthEdge) return { day: t };
    return { error: `the student didn't name ${t}; use a relative token (today, +14d, end_of_month…), never a date you worked out` };
  }
  return { error: `unknown range word "${token}"` };
}

/** A range from two tokens, inclusive, against `now` in Eastern time. From after to is swapped. */
export function resolveRange(from: string, to: string, now: number, studentText: string): DayRange | { error: string } {
  const today = easternDay(now)!;
  const a = resolveDay(from || "today", today, studentText);
  if ("error" in a) return a;
  const b = resolveDay(to || "+14d", today, studentText);
  if ("error" in b) return b;
  const [f, t] = a.day <= b.day ? [a.day, b.day] : [b.day, a.day];
  return { from: f, to: t, label: f === t ? dayLabel(f) : `${dayLabel(f)} – ${dayLabel(t)}` };
}

/** Is an instant (or a bare day) inside the range, by its Eastern day? */
export function inRange(value: string, r: Pick<DayRange, "from" | "to">): boolean {
  const day = easternDay(value);
  return !!day && day >= r.from && day <= r.to;
}
