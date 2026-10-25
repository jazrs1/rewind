// Quick build (beta), "Add lecture recordings (optional)": the transcripts the student exported from Zoom with the
// Rewind extension, read back from the extension on this device ({ type: 'transcripts' }, extension/bridge.js). No new
// permission: the extension keeps them in its own storage, and only Rewind's own origins can ask for them.

import type { Transcript } from "../schema.ts";
import { readFile } from "./export.ts";

/** What the extension answers (lib/player/zoom-remote.ts's sender, or a fake). */
export type BridgeSend = (msg: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; transcripts?: unknown }>;

export type Exported = { ok: true; transcripts: Transcript[] } | { ok: false; error: string };

/** The exported transcripts, each read the way a picked .transcript.json is (readFile); anything else is dropped. */
export async function exportedTranscripts(send: BridgeSend): Promise<Exported> {
  const r = await send({ type: "transcripts" }).catch(() => ({ ok: false, error: "no-extension" }) as const);
  if (!r.ok) return { ok: false, error: r.error ?? "error" };
  const list = Array.isArray(r.transcripts) ? r.transcripts : [];
  const out: Transcript[] = [];
  for (const t of list) {
    const got = readFile(t);
    if (got?.kind === "transcript" && got.transcript.recordingUrl) out.push(got.transcript);
  }
  return { ok: true, transcripts: out };
}

export const POLL_MS = 2000;

/**
 * Asks the extension every 2 s while the step is open, and reports each answer (the count rises as transcripts arrive).
 * Returns stop. `setTimer`/`clearTimer` are a test's.
 */
export function watchExported(
  send: BridgeSend,
  onUpdate: (r: Exported) => void,
  o: { every?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {},
): () => void {
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown = null;
  const tick = async () => {
    const r = await exportedTranscripts(send);
    if (stopped) return;
    onUpdate(r);
    timer = setTimer(() => void tick(), o.every ?? POLL_MS);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}

/** Transcripts from both places, one per recording (a picked file wins over the extension's copy of the same recording). */
export function mergeTranscripts(picked: Transcript[], exported: Transcript[]): Transcript[] {
  const seen = new Set(picked.map((t) => t.recordingUrl));
  return [...picked, ...exported.filter((t) => !seen.has(t.recordingUrl))];
}
