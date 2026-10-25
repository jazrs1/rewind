// Packs the spike into a practice seed for the app: questions, answers, rewind matches, the
// lecture lines around each clip, and slide page images. Everything lands in private/demo/.
// Run: npm run spike:seed [-- --results private/spike/results-exact.json] [--questions generated|hand]
//
// --questions generated (default): for each topic, Claude Opus writes one question from that topic's
// clip (exampleStart to clip end) and slide, with John's hand-written questions as the style examples
// (stand-ins for the past reviews), through the pipeline's generate + check stage
// (lib/pipeline/generate.ts: lib/prompts/question-gen.ts, the quality rules in lib/questions/rules.ts,
// the answer check in lib/prompts/answer-check.ts). Its rewind target is the clip it was generated from.
// A question rejected 3 times (1 + 2 retries) is left out; private/demo/questions-report.json says why
// and counts the attempts each rule rejected.
// Needs ANTHROPIC_API_KEY (.env.local); spend goes to $LLM_USAGE_LOG through lib/llm.ts.
// --questions hand: John's hand-written questions (private/spike/questions.txt + answers.json), no API calls.
// The headline rewind number is measured on the hand-written set.

import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractText } from "unpdf";
import { parseQuestionLine, type PracticeSeed, type RadarMoment, type SeedQuestion } from "../../lib/demo/types.ts";
import { generateQuestion, type GenerateResult, ruleTally, sourceLabel } from "../../lib/pipeline/generate.ts";
import { toQuoteSource } from "../../lib/questions/quote-source.ts";
import { formatTime } from "../../lib/format.ts";
import type { ChoiceLabel, TranscriptSegment } from "../../lib/schema.ts";
import { loadTranscript } from "./match.ts";
// The worker's radar scan (plain JS module); same phrase list the CLI uses.
import { loadPhrases, scanTranscript } from "../radar/scan.mjs";

const SPIKE = "private/spike";
const OUT = "private/demo";
/** Lines kept after the clip, so "Keep listening" has captions. */
const AFTER_SEC = 45;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function slidePages(path: string): Promise<string[]> {
  const { text } = await extractText(new Uint8Array(await readFile(path)), { mergePages: false });
  return text.map((t) => t.replace(/\s+/g, " ").trim());
}

interface Result {
  n: number;
  start: number | null;
  playFrom: number | null;
  end: number | null;
  exampleStart: number | null;
  setup: string | null;
  sourceLines: number[];
  slide: { deck: string; page: number };
}

async function main() {
  const set = arg("questions") ?? "generated";
  if (set !== "generated" && set !== "hand") throw new Error(`--questions must be generated or hand, not "${set}"`);
  const resultsPath = arg("results") ?? join(SPIKE, "results-exact.json");
  const { transcript: transcriptPath, lecturer, results } = JSON.parse(await readFile(resultsPath, "utf8")) as {
    transcript: string;
    lecturer: string;
    results: Result[];
  };
  const transcript = await loadTranscript(transcriptPath);
  const answers = JSON.parse(await readFile(join(SPIKE, "answers.json"), "utf8")) as Record<string, ChoiceLabel>;
  const lines = (await readFile(join(SPIKE, "questions.txt"), "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  const recordingUrl = (await readFile(join(SPIKE, "transcript.txt"), "utf8")).split("\n")[0].trim();
  await mkdir(join(OUT, "slides"), { recursive: true });
  // Canvas links for the decks, from John's export when it's there (private/COP3530.course.json).
  const exp = await readFile("private/COP3530.course.json", "utf8")
    .then((s) => JSON.parse(s) as { course: { id: number }; files: { id: number; display_name?: string }[] })
    .catch(() => null);
  const fileIdFor = (deck: string) => exp?.files.find((x) => (x.display_name ?? "").replace(/\.pdf$/i, "") === deck)?.id ?? null;
  const canvasUrlFor = (deck: string) => {
    const id = fileIdFor(deck);
    return exp && id ? `https://ufl.instructure.com/courses/${exp.course.id}/files/${id}` : undefined;
  };
  const course = { code: "COP3530", name: "Data Structures and Algorithms" };

  const questions: SeedQuestion[] = [];
  const generated: GenerateResult[] = [];
  const report: { n: number; status: GenerateResult["status"]; reason?: string; attempts: GenerateResult["attempts"] }[] = [];
  const decks = new Map<string, string[]>();
  const kept: string[] = [];
  for (const r of results) {
    if (r.playFrom === null || r.end === null) throw new Error(`Q${r.n} has no rewind; rerun spike:match`);
    const answer = answers[`Q${r.n}`];
    if (!answer) throw new Error(`No answer for Q${r.n} in ${SPIKE}/answers.json`);
    let q: Pick<SeedQuestion, "stem" | "code" | "choices" | "answer" | "explanation" | "source"> = { ...parseQuestionLine(lines[r.n - 1]), answer };

    if (set === "generated") {
      // The same material the A/B gave the models: every line from exampleStart to the clip end, and the slide page's text.
      const from = r.exampleStart ?? r.start ?? r.playFrom;
      const clipLines = transcript.segments.filter((s) => s.start >= from - 0.01 && s.end <= r.end! + 0.01);
      const deckPath = join(SPIKE, `${r.slide.deck}.pdf`);
      if (!decks.has(deckPath)) decks.set(deckPath, await slidePages(deckPath));
      const slideText = decks.get(deckPath)![r.slide.page - 1] ?? "";
      const fileId = fileIdFor(r.slide.deck);
      // Style: John's hand-written questions stand in for the past reviews (none downloaded yet); this topic's first.
      const style = [lines[r.n - 1], ...lines.filter((_, i) => i !== r.n - 1)].map((text) => ({ itemId: "local:hand-written-practice", text }));
      const g = await generateQuestion(
        {
          topic: r.slide.deck,
          examId: null,
          passages: [
            {
              id: "P1",
              label: `lecture ${formatTime(from)} to ${formatTime(r.end)}`,
              lines: clipLines.map((s) => ({ start: s.start, text: s.text })),
              source: { kind: "lecture", itemId: "oct22", recordingUrl, start: from, end: r.end, title: "Lecture, Oct 22" },
            },
            {
              id: "P2",
              label: `slide ${r.slide.page} of "${r.slide.deck}"`,
              text: slideText,
              source: {
                kind: "slide",
                itemId: fileId ? `file:${fileId}` : `local:${slug(r.slide.deck)}`,
                fileId: fileId ?? 0,
                deck: r.slide.deck,
                page: r.slide.page,
                href: canvasUrlFor(r.slide.deck),
              },
            },
          ],
          style,
        },
        { course, id: `q${r.n}`, avoid: [...kept] },
      );
      generated.push(g);
      report.push({ n: r.n, status: g.status, ...(g.status === "dropped" ? { reason: g.reason } : {}), attempts: g.attempts });
      if (g.status === "dropped") {
        console.log(`Q${r.n}: dropped after ${g.attempts.length} attempts: ${g.reason}`);
        continue;
      }
      const { stem, code, choices, explanation, quote, quoteSource } = g.question;
      const where = toQuoteSource(quoteSource);
      if (!where) throw new Error(`Q${r.n}: quote source ${quoteSource.kind} has no seed form`);
      q = { stem, ...(code ? { code: { language: code.language, lines: code.lines } } : {}), choices, answer: g.question.answer, explanation, source: { quote, where } };
      kept.push(stem);
      console.log(`Q${r.n}: kept on attempt ${g.attempts.length} (check answered ${g.check.answer}; quote from ${sourceLabel(quoteSource)}): ${stem}`);
    }

    const image = `${slug(r.slide.deck)}-p${r.slide.page}.png`;
    const imagePath = join(OUT, "slides", image);
    if (!(await exists(imagePath))) {
      const pdf = join(SPIKE, `${r.slide.deck}.pdf`);
      await promisify(execFile)("swift", ["scripts/spike/render-page.swift", pdf, String(r.slide.page), imagePath, "1600"]);
    }

    const from = Math.min(r.exampleStart ?? r.playFrom, r.playFrom) - 5;
    const segments = transcript.segments.filter((s) => s.speaker === lecturer && s.start >= from && s.start < r.end! + AFTER_SEC);

    questions.push({
      id: `q${r.n}`,
      n: questions.length + 1,
      ...q,
      match: {
        start: r.playFrom,
        end: r.end,
        exampleStart: r.exampleStart,
        setup: r.setup,
        sourceLines: r.sourceLines,
        slide: { ...r.slide, image, canvasUrl: canvasUrlFor(r.slide.deck) },
      },
      segments,
    });
  }

  // Exam radar: hits from the lecturer only, one entry per moment (a line can match several phrases).
  const hits = scanTranscript(transcript, transcriptPath, loadPhrases(), { speaker: lecturer }) as {
    start: number;
    kind: string | null;
    phrase: string;
    text: string;
    context: TranscriptSegment[];
  }[];
  const moments = new Map<number, RadarMoment>();
  for (const h of hits) {
    const m = moments.get(h.start) ?? { start: h.start, kinds: [], phrases: [], text: h.text, context: h.context.filter((c) => c.speaker === lecturer) };
    if (h.kind && !m.kinds.includes(h.kind)) m.kinds.push(h.kind);
    if (!m.phrases.includes(h.phrase)) m.phrases.push(h.phrase);
    moments.set(h.start, m);
  }
  // Near-duplicates seconds apart are one moment: keep the first line, add the later one's kinds and phrases.
  const radar: RadarMoment[] = [];
  for (const m of [...moments.values()].sort((a, b) => a.start - b.start)) {
    const prev = radar[radar.length - 1];
    if (prev && m.start - prev.start < 15) {
      for (const k of m.kinds) if (!prev.kinds.includes(k)) prev.kinds.push(k);
      for (const p of m.phrases) if (!prev.phrases.includes(p)) prev.phrases.push(p);
      for (const c of m.context) if (!prev.context.some((x) => x.start === c.start)) prev.context.push(c);
      prev.context.sort((a, b) => a.start - b.start);
    } else radar.push(m);
  }

  const seed: PracticeSeed = {
    course: { code: "COP3530", name: "Data Structures and Algorithms" },
    set: "Lecture practice, Oct 22",
    lecturer: { name: lecturer, short: lecturer.split(" ").slice(-1)[0] },
    recordingUrl,
    questions,
    questionSet: set,
    radar,
    lectureTitle: "Lecture, Oct 22",
  };
  await writeFile(join(OUT, "seed.json"), JSON.stringify(seed, null, 2));
  if (set === "generated") {
    const tally = ruleTally(generated);
    await writeFile(join(OUT, "questions-report.json"), JSON.stringify({ tally, questions: report }, null, 2));
    console.log(`Kept ${tally.kept} of ${generated.length} (${tally.attempts} attempts). Attempts rejected by rule: ${JSON.stringify(tally.rejectedBy)}`);
  }
  console.log(`Wrote ${join(OUT, "seed.json")}: ${questions.length} ${set} questions, ${radar.length} radar moments, slides in ${join(OUT, "slides")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
