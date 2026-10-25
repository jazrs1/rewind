// Quick build (beta), in the browser: "Build my practice". Sends the batches one at a time to /api/quick/generate,
// reports progress, and stops at 15 questions. Returns the questions; the caller keeps them on this device.

import { batchesOf, chunksOf, pickChunks, type ExportFiles } from "./export.ts";
import { LIMITS, type QuickQuestion, type QuickResponse } from "./types.ts";

export interface Progress {
  /** Batches finished, of `total`. */
  done: number;
  total: number;
  questions: number;
}

export type Stop = "limit" | "rate" | "unavailable" | "off" | "error" | "nothing";

export interface BuildResult {
  questions: QuickQuestion[];
  /** Why it ended short of everything it meant to do, or null. */
  stopped: Stop | null;
}

const STOPS: Record<number, Stop> = { 404: "off", 429: "limit", 503: "unavailable", 502: "error" };
/** A refusal that is the route's trouble, not the text's: the day's budget, the counter store, the model. */
const ROUTE_TROUBLE: Record<string, Stop | undefined> = { budget: "limit", store: "unavailable", error: "error" };

/** What to tell the student for each stop. */
export const STOP_TEXT: Record<Stop, string> = {
  limit: "That's today's limit of 15 questions. Try again tomorrow.",
  rate: "Too many tries in a minute. Wait a minute and press Build my practice again.",
  unavailable: "Quick build isn't available right now. Nothing was saved.",
  off: "Quick build isn't turned on here.",
  error: "Something went wrong while writing questions.",
  nothing: "There wasn't enough course text to write questions from.",
};

export async function buildPractice(o: { files: ExportFiles; fetchFn?: typeof fetch; onProgress?: (p: Progress) => void; signal?: AbortSignal }): Promise<BuildResult> {
  const fetcher = o.fetchFn ?? fetch;
  const { chunks } = chunksOf(o.files);
  const batches = batchesOf(pickChunks(chunks), o.files.course);
  if (!batches.length) return { questions: [], stopped: "nothing" };
  const questions: QuickQuestion[] = [];
  const stems = new Set<string>();
  let stopped: Stop | null = null;
  o.onProgress?.({ done: 0, total: batches.length, questions: 0 });
  for (const [i, batch] of batches.entries()) {
    if (questions.length >= LIMITS.questionsPerBuild || o.signal?.aborted) break;
    let res: Response;
    try {
      res = await fetcher("/api/quick/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch), signal: o.signal, cache: "no-store" });
    } catch {
      stopped = "error";
      break;
    }
    if (!res.ok) {
      let why = "";
      try {
        why = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        // no body
      }
      stopped = res.status === 429 && why === "rate" ? "rate" : (STOPS[res.status] ?? "error");
      break;
    }
    const body = (await res.json().catch(() => null)) as QuickResponse | null;
    // A 200 can still be a stop: no question, and every refusal the route's own trouble (the $4 day, the store, the model).
    const trouble = body && !body.questions?.length && body.refused?.length ? body.refused.map((r) => ROUTE_TROUBLE[r.reason]) : [];
    if (trouble.length && trouble.every(Boolean)) {
      stopped = trouble[0]!;
      break;
    }
    for (const q of body?.questions ?? []) {
      const key = q.stem.toLowerCase();
      if (!stems.has(key) && questions.length < LIMITS.questionsPerBuild) {
        stems.add(key);
        questions.push(q);
      }
    }
    o.onProgress?.({ done: i + 1, total: batches.length, questions: questions.length });
  }
  return { questions, stopped: questions.length ? stopped : (stopped ?? "nothing") };
}

/** When nothing was built because the route couldn't help (off, unavailable, capped, erroring). */
export const COULDNT_BUILD = "Couldn't build practice right now. Your files never left this device; try again in a minute.";
/** The reason shown with that line, for the caps only. */
export const STOP_TAG: Partial<Record<Stop, string>> = { limit: "today's limit reached", rate: "too many tries this minute" };

export interface Outcome {
  /** The status line under the progress bar, or null when the build failed (the alert says it all). */
  status: string | null;
  /** Said once, as an alert: why it stopped short, or that it couldn't build. */
  alert: string | null;
  /** Nothing was built because the route was off, unavailable, capped or erroring. */
  failed: boolean;
}

const count = (n: number) => `${n} question${n === 1 ? "" : "s"}`;

/** What the build step says when it ends. Never "Done: 0 questions". */
export function outcomeOf(r: BuildResult): Outcome {
  if (r.questions.length) return { status: `Done: ${count(r.questions.length)}.`, alert: r.stopped ? STOP_TEXT[r.stopped] : null, failed: false };
  if (r.stopped === "nothing" || r.stopped === null) return { status: null, alert: STOP_TEXT.nothing, failed: false };
  const tag = STOP_TAG[r.stopped];
  const text = tag ? COULDNT_BUILD.replace("right now.", `right now (${tag}).`) : COULDNT_BUILD;
  // The daily cap doesn't clear in a minute.
  return { status: null, alert: r.stopped === "limit" ? text.replace("try again in a minute.", "try again tomorrow.") : text, failed: true };
}
