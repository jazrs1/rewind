// What makes a hosted clip's transcript sound like a student is in it (scripts/demo/speaker-check.ts). Pure.

export interface Turn {
  speaker: string | null;
  start: number | null;
  end: number | null;
  text: string;
}

/** Phrases a student says, not the lecturer. */
const STUDENT = /\b(can you (please )?repeat|could you (please )?repeat|sorry,? (i|what)|i have a question|quick question|is (it|that) going to be on the (exam|test)|what did you say|i didn'?t (get|hear) (that|it)|professor,)/i;

/**
 * Lines that keep a clip out pending a human listen: any turn by a speaker other than the clip's main one (the one
 * with the most words), a student-sounding phrase, or a name from the redact list.
 */
export function studentLines(turns: Turn[], names: string[] = []): { why: string; speaker: string | null; text: string }[] {
  const words = new Map<string | null, number>();
  for (const t of turns) words.set(t.speaker, (words.get(t.speaker) ?? 0) + t.text.split(/\s+/).filter(Boolean).length);
  const main = [...words].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const nameRe = names.length ? new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i") : null;
  const out: { why: string; speaker: string | null; text: string }[] = [];
  for (const t of turns) {
    if (t.speaker !== main) out.push({ why: `second speaker ${t.speaker ?? "?"}`, speaker: t.speaker, text: t.text });
    else if (STUDENT.test(t.text)) out.push({ why: "sounds like a student", speaker: t.speaker, text: t.text });
    else if (nameRe?.test(t.text)) out.push({ why: "a name", speaker: t.speaker, text: t.text });
  }
  return out;
}
