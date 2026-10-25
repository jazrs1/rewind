// Blind A/B: Gemini 3.8 Flash vs Claude Opus 5.5 writing one new practice question per topic.
// Both models get the SAME prompt: the matched clip's transcript lines (exampleStart to clip end,
// from the matcher's results JSON) and the matched slide page's text. Each quote is checked word
// for word against that material. Writes ab.md (X/Y only, random order per topic) and key.json
// (which model is X, quote-verification counts, measured cost).
//
// Run: node --env-file=/path/to/.env.local scripts/eval/ab.ts [--topics oct22,oct20] [--out private/eval/ab.md] [--key private/eval/key.json]
// A topic is a lecture id (all its questions) or lecture:n (one question), e.g. --topics oct13 or oct22:3.
// Oct 13 (sorting) needs private/lectures/results-oct13.json from the matcher first:
//   npm run spike:match -- --transcript private/lectures/DSA_Fa26_-_Tue_Lecture_2026-10-13.transcript.json \
//     --questions private/lectures/questions-oct13.txt --deck "6 - Sorting" --tag oct13 ...

import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractText } from "unpdf";
import { formatTime } from "../../lib/format.ts";
import { MODELS } from "../../lib/gemini.ts";
import { CLAUDE_OPUS, createLLM, type ModelRef, type UsageRecord } from "../../lib/llm.ts";
import { loadTranscript } from "../spike/match.ts";
import { quoteAppears } from "./quote.ts";

interface Lecture {
  label: string;
  questions: string;
  results: string;
  slidesDir: string;
}

export const LECTURES: Record<string, Lecture> = {
  oct13: {
    label: "Oct 13",
    questions: "private/lectures/questions-oct13.txt",
    results: "private/lectures/results-oct13.json",
    slidesDir: "private/spike",
  },
  oct20: {
    label: "Oct 20",
    questions: "private/lectures/questions-oct20.txt",
    results: "private/lectures/results-oct20.json",
    slidesDir: "private/spike",
  },
  oct22: {
    label: "Oct 22",
    questions: "private/spike/questions.txt",
    results: "private/spike/results-exact.json",
    slidesDir: "private/spike",
  },
};

const CONTESTANTS: ModelRef[] = [
  { provider: "gemini", model: MODELS.flash },
  { provider: "anthropic", model: CLAUDE_OPUS },
];

interface MatchResult {
  n: number;
  question: string;
  start: number | null;
  end: number | null;
  exampleStart: number | null;
  slide: { deck: string; page: number };
}

interface Generated {
  stem: string;
  choices: { A: string; B: string; C: string; D: string };
  answer: "A" | "B" | "C" | "D";
  explanation: string;
  quote: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    stem: { type: "string", description: "The question stem" },
    choices: {
      type: "object",
      properties: { A: { type: "string" }, B: { type: "string" }, C: { type: "string" }, D: { type: "string" } },
      required: ["A", "B", "C", "D"],
    },
    answer: { type: "string", enum: ["A", "B", "C", "D"] },
    explanation: { type: "string", description: "One sentence" },
    quote: { type: "string", description: "Copied word for word from the lecture lines or the slide text" },
  },
  required: ["stem", "choices", "answer", "explanation", "quote"],
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function prompt(topicQuestion: string, lectureLines: string, deck: string, page: number, slideText: string): string {
  return `You write practice questions for a university data structures and algorithms course (COP3530), in the style of the professor's own lecture and exam questions.

A student already practiced with this question:
${topicQuestion}

Below is what the professor said about this concept in lecture (each line starts with its time in the recording), and the text of the slide he was showing.

LECTURE LINES
${lectureLines}

SLIDE ("${deck}", page ${page})
${slideText}

Write ONE new multiple-choice practice question on the same concept, in the professor's style. It must be different from the question above (a new example, new numbers or a new angle), answerable from the lecture lines and slide alone, with exactly one correct choice.

Return:
- stem: the question.
- choices: four choices, A to D.
- answer: the letter of the correct choice.
- explanation: one sentence on why that choice is right.
- quote: a passage copied word for word from the LECTURE LINES or the SLIDE text above that supports the answer. Copy it exactly: no timestamps, no ellipses, no rewording. 8 to 40 words.`;
}

async function slidePages(path: string): Promise<string[]> {
  const { text } = await extractText(new Uint8Array(await readFile(path)), { mergePages: false });
  return text.map((t) => t.replace(/\s+/g, " ").trim());
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function renderQuestion(label: string, g: Generated, verified: boolean): string[] {
  return [
    `### ${label}`,
    "",
    g.stem.trim(),
    "",
    ...(["A", "B", "C", "D"] as const).map((k) => `- (${k}) ${g.choices[k].trim()}`),
    "",
    `- Answer: ${g.answer}`,
    `- Explanation: ${g.explanation.trim()}`,
    `- Quote: "${g.quote.trim()}"`,
    `- Quote verified: ${verified ? "yes" : "no"}`,
    "",
  ];
}

async function main() {
  const topicArg = (arg("topics") ?? "oct22,oct20").split(",").map((s) => s.trim()).filter(Boolean);
  const outPath = arg("out") ?? "private/eval/ab.md";
  const keyPath = arg("key") ?? "private/eval/key.json";
  const llm = createLLM();
  const usageBefore = (await llm.readUsage()).length;

  // Build the topic list.
  interface Topic {
    id: string;
    lecture: Lecture;
    result: MatchResult;
    lines: string;
    sources: string[];
    slideText: string;
  }
  const topics: Topic[] = [];
  const decks = new Map<string, string[]>();
  for (const t of topicArg) {
    const [lectureId, nStr] = t.split(":");
    const lecture = LECTURES[lectureId];
    if (!lecture) throw new Error(`Unknown lecture "${lectureId}". Known: ${Object.keys(LECTURES).join(", ")}`);
    let resultsJson: { transcript: string; results: MatchResult[] };
    try {
      resultsJson = JSON.parse(await readFile(lecture.results, "utf8"));
    } catch {
      throw new Error(`${lecture.results} not found. Run the matcher for ${lecture.label} first (see the header of this script).`);
    }
    const transcript = await loadTranscript(resultsJson.transcript);
    const wanted = nStr ? resultsJson.results.filter((r) => r.n === Number(nStr)) : resultsJson.results;
    for (const r of wanted) {
      if (r.start === null || r.end === null) {
        console.log(`Skipping ${lectureId}:${r.n}: the matcher found no clip.`);
        continue;
      }
      const from = r.exampleStart ?? r.start;
      const segs = transcript.segments.filter((s) => s.start >= from - 0.01 && s.end <= r.end! + 0.01);
      const deckPath = join(lecture.slidesDir, `${r.slide.deck}.pdf`);
      if (!decks.has(deckPath)) decks.set(deckPath, await slidePages(deckPath));
      const slideText = decks.get(deckPath)![r.slide.page - 1] ?? "";
      topics.push({
        id: `${lectureId}:${r.n}`,
        lecture,
        result: r,
        lines: segs.map((s) => `[${formatTime(s.start)}] ${s.text}`).join("\n"),
        sources: [segs.map((s) => s.text).join(" "), slideText],
        slideText,
      });
    }
  }
  console.log(`${topics.length} topics x ${CONTESTANTS.length} models`);

  const done = await mapLimit(topics, 4, async (t) => {
    const p = prompt(t.result.question, t.lines, t.result.slide.deck, t.result.slide.page, t.slideText);
    const outs = await Promise.all(
      CONTESTANTS.map(async (m) => {
        const g = await llm.generateJSON<Generated>(m, p, SCHEMA);
        return { model: m.model, g, verified: quoteAppears(g.quote, t.sources) };
      }),
    );
    const flip = randomInt(2) === 1;
    const [x, y] = flip ? [outs[1], outs[0]] : outs;
    console.log(`${t.id}: done`);
    return { t, x, y };
  });

  // Measured cost: the usage lines this run appended (paid calls only; cached calls cost nothing).
  const fresh: UsageRecord[] = (await llm.readUsage()).slice(usageBefore);
  const cost = Object.fromEntries(
    CONTESTANTS.map((m) => {
      const recs = fresh.filter((r) => r.model === m.model);
      const usd = recs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
      return [
        m.model,
        {
          paidCalls: recs.length,
          inputTokens: recs.reduce((n, r) => n + r.inputTokens, 0),
          outputTokens: recs.reduce((n, r) => n + r.outputTokens, 0),
          costUsd: Number(usd.toFixed(5)),
          perQuestionUsd: recs.length ? Number((usd / recs.length).toFixed(5)) : null,
          servedBy: [...new Set(recs.map((r) => r.servedModel))],
        },
      ];
    }),
  );

  const verifiedCounts = Object.fromEntries(
    CONTESTANTS.map((m) => {
      const all = done.flatMap((d) => [d.x, d.y]).filter((o) => o.model === m.model);
      return [m.model, { yes: all.filter((o) => o.verified).length, no: all.filter((o) => !o.verified).length }];
    }),
  );

  const md = [
    "# Blind A/B: practice questions",
    "",
    "Two models each wrote one new practice question per topic from the same lecture lines and slide. Their order is random per topic. Mark which is better for studying (correct, clear, in Kapoor's style, and the quote really supports the answer). The key is in key.json; don't open it until you're done.",
    "",
    ...done.flatMap(({ t, x, y }, i) => {
      const r = t.result;
      return [
        `## Topic ${i + 1}: ${t.lecture.label}, practice question ${r.n}`,
        "",
        `Practice question it replaces: ${r.question}`,
        "",
        `Material given: lecture ${formatTime(r.exampleStart ?? r.start!)} to ${formatTime(r.end!)}; slide "${r.slide.deck}" page ${r.slide.page}.`,
        "",
        ...renderQuestion("X", x.g, x.verified),
        ...renderQuestion("Y", y.g, y.verified),
        "**Better: X / Y / tie** (circle one): ______",
        "",
        "Notes:",
        "",
        "---",
        "",
      ];
    }),
  ].join("\n");

  const key = {
    generatedAt: new Date().toISOString(),
    topicsArg: topicArg.join(","),
    prompt: "Same prompt for both models; see prompt() in scripts/eval/ab.ts. Claude: effort medium, structured output. Gemini: structured output, default config.",
    quoteRule:
      "Verified = the quote's words appear in the same order in the lecture lines (exampleStart to clip end) or the slide page text; case, punctuation and spacing ignored; ellipses fail; at least 3 words (scripts/eval/quote.ts).",
    mapping: done.map(({ t, x, y }, i) => ({ topic: i + 1, id: t.id, X: x.model, Y: y.model, quoteVerified: { X: x.verified, Y: y.verified } })),
    quoteVerifiedCounts: verifiedCounts,
    cost,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await mkdir(dirname(keyPath), { recursive: true });
  await writeFile(outPath, md);
  await writeFile(keyPath, JSON.stringify(key, null, 2));
  console.log(`Wrote ${outPath} and ${keyPath}. Claude spend logged so far: $${(await llm.claudeSpent()).toFixed(4)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
