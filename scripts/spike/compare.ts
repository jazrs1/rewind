// How far off are the estimated start times? For each chosen rewind in a results file,
// finds where its first sentence really starts in a timed reference:
//   --ref <transcript>  per-item times (e.g. the saved Zoom page, private/fixtures/zoom-recording.html)
//   --audio <file>      word-level times from Gemini Transcribe, on a clip around each start
// Run: npm run spike:compare -- --results private/spike/results-estimated.json --ref ... | --audio ...
//      [--other private/spike/results-exact.json]   (also show what a run on the reference picked)

import { readFile } from "node:fs/promises";
import { formatTime } from "../../lib/format.ts";
import { locate, wordsFromSegments } from "./align.ts";
import { audioWords, CLIP_HALF_SEC } from "./audio.ts";
import { loadTranscript } from "./match.ts";

const THRESHOLD_SEC = 10;

interface Result {
  n: number;
  start: number | null;
  startEstimated: boolean;
  clipText: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const resultsPath = arg("results");
  const refPath = arg("ref");
  const audio = arg("audio");
  if (!resultsPath || (!refPath && !audio)) {
    console.error("Usage: npm run spike:compare -- --results <results.json> (--ref <transcript> | --audio <file>) [--other <results.json>]");
    process.exit(2);
  }
  const { results } = JSON.parse(await readFile(resultsPath, "utf8")) as { results: Result[] };
  const otherPath = arg("other");
  const other = otherPath ? (JSON.parse(await readFile(otherPath, "utf8")) as { results: Result[] }).results : null;
  const refWords = refPath ? wordsFromSegments((await loadTranscript(refPath)).segments) : null;

  console.log(`Reference: ${refPath ? `${refPath} (per-item times)` : `${audio} (Gemini Transcribe, word-level)`}\n`);
  let over = 0;
  let measured = 0;
  for (const r of results) {
    if (r.start === null) {
      console.log(`Q${r.n}: no rewind chosen`);
      continue;
    }
    const words = refWords ?? (await audioWords(audio!, r.start));
    const hit = locate(r.clipText, words);
    const otherPick = other?.find((o) => o.n === r.n)?.start ?? null;
    const otherNote =
      otherPick === null || !other
        ? ""
        : hit && Math.abs(otherPick - hit.start) < 40
          ? `; reference run picked ${formatTime(otherPick)} (same moment)`
          : `; reference run picked ${formatTime(otherPick)} (a different moment)`;
    if (!hit) {
      console.log(`Q${r.n}: ${formatTime(r.start)} -> not found in the reference${audio ? ` (within ±${CLIP_HALF_SEC} s)` : ""}${otherNote}`);
      continue;
    }
    const delta = hit.start - r.start;
    measured++;
    if (Math.abs(delta) > THRESHOLD_SEC) over++;
    console.log(
      `Q${r.n}: ${formatTime(r.start)}${r.startEstimated ? " (estimated)" : ""} -> really ${formatTime(hit.start)}` +
        `  ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} s${Math.abs(delta) > THRESHOLD_SEC ? "  MOVES > 10 s" : ""}` +
        `  (match ${Math.round(hit.score * 100)}%)${otherNote}`,
    );
  }
  console.log(`\n${over} of ${measured} measured starts move by more than ${THRESHOLD_SEC} s.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
