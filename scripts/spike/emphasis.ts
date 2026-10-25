// Suggests the emphasis phrases a professor actually uses ("this is a classic interview
// question", "remember this for the exam"), for the exam radar's phrase list.
// Every suggestion must come with a quote that appears word for word in the transcript.
// Run: npm run spike:emphasis [-- --transcript private/fixtures/zoom-recording.html]
// Writes private/spike/emphasis-suggestions.json (real quotes stay in private/).

import { writeFile } from "node:fs/promises";
import { formatTime } from "../../lib/format.ts";
import { generateJSON, MODELS } from "../../lib/gemini.ts";
import { loadTranscript } from "./match.ts";

interface Suggestion {
  phrase: string;
  pattern: string;
  kind: "exam" | "importance" | "common-mistake" | "interview" | "recall";
  quotes: string[];
}

type Checked = Suggestion & { hits: number; at: string[] };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function main() {
  const path = arg("transcript") ?? "private/fixtures/zoom-recording.html";
  const t = await loadTranscript(path);
  const chars = new Map<string, number>();
  for (const s of t.segments) if (s.speaker) chars.set(s.speaker, (chars.get(s.speaker) ?? 0) + s.text.length);
  const lecturer = [...chars].sort((a, b) => b[1] - a[1])[0][0];
  const lines = t.segments.filter((s) => s.speaker === lecturer);
  const text = lines.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n");

  const { suggestions } = await generateJSON<{ suggestions: Suggestion[] }>(
    MODELS.flash,
    `Here is a full lecture transcript from a data structures course (COP3530). Each line starts with its time.

${text}

Find the phrases this professor uses to flag that something matters for students: it will be on an exam or quiz, it's important, it's a common mistake, it's a classic interview question, or students should remember it. List the recurring wording he actually uses, as reusable phrases (not one-off sentences).

For each: phrase (a short label), pattern (a JavaScript regular expression, case-insensitive, matching his variants with word boundaries), kind, and quotes (1 to 3 exact quotes copied word for word from the transcript where he says it, without the timestamp).`,
    {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              phrase: { type: "string" },
              pattern: { type: "string" },
              kind: { type: "string", enum: ["exam", "importance", "common-mistake", "interview", "recall"] },
              quotes: { type: "array", items: { type: "string" } },
            },
            required: ["phrase", "pattern", "kind", "quotes"],
          },
        },
      },
      required: ["suggestions"],
    },
    { temperature: 0 },
  );

  // Keep only suggestions whose quotes really appear and whose pattern compiles and matches them.
  const haystack = norm(lines.map((s) => s.text).join(" "));
  const kept: Checked[] = [];
  const dropped: Checked[] = [];
  for (const s of suggestions) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(s.pattern, "i");
    } catch {
      // invalid pattern
    }
    const quotes = s.quotes.filter((q) => haystack.includes(norm(q)));
    const hits = re ? lines.filter((l) => re!.test(l.text)) : [];
    const ok = re !== null && quotes.length > 0 && quotes.some((q) => re!.test(q));
    const entry = { ...s, quotes, hits: hits.length, at: hits.slice(0, 5).map((h) => formatTime(h.start)) };
    (ok ? kept : dropped).push(entry);
  }

  const out = "private/spike/emphasis-suggestions.json";
  await writeFile(out, JSON.stringify({ transcript: path, lecturer, kept, dropped }, null, 2));
  console.log(`${kept.length} phrases kept, ${dropped.length} dropped (quote not word for word, or pattern doesn't match it):`);
  for (const k of kept) console.log(`  [${k.kind}] ${k.phrase}  /${k.pattern}/i  hits: ${k.hits} at ${k.at.join(", ")}`);
  for (const d of dropped) console.log(`  dropped: ${d.phrase}`);
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
