"use client";

// Quick build (beta), step 2 of BuildPractice: "Add lecture recordings (optional)". Three short steps, and a live count
// of the transcripts the student has exported with the extension (asked every 2 s; lib/quick/recordings.ts). Skippable:
// slides, PDFs and pages still build practice without recordings. No new extension permission.

import { useEffect, useRef, useState } from "react";
import { extensionId } from "@/lib/extension";
import { extensionSender } from "@/lib/player/zoom-remote";
import { watchExported, type BridgeSend } from "@/lib/quick/recordings";
import type { Transcript } from "@/lib/schema";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function AddRecordings({ onChange, onSkip }: { onChange: (t: Transcript[]) => void; onSkip: () => void }) {
  const [state, setState] = useState<{ count: number; reachable: boolean } | null>(null);
  const changed = useRef(onChange);

  useEffect(() => {
    changed.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const send = extensionSender(extensionId()) as unknown as BridgeSend;
    return watchExported(send, (r) => {
      if (r.ok) {
        setState({ count: r.transcripts.length, reachable: true });
        changed.current(r.transcripts);
      } else setState({ count: 0, reachable: false });
    });
  }, []);

  return (
    <div data-quick-recordings="" className="flex flex-col gap-3">
      <p className="m-0 text-[15px] leading-snug text-label-muted">Recordings add rewind moments to your questions. Slides and PDFs still give you practice without them.</p>
      <ol className="m-0 flex list-decimal flex-col gap-1 pl-6 text-[15px] leading-snug" data-quick-recording-steps="">
        <li>Open a recording from your course&apos;s Zoom tab in Canvas.</li>
        <li>
          Click <strong>Rewind: export transcript</strong> at the bottom right of the recording.
        </li>
        <li>Come back here. Each one you export is added.</li>
      </ol>
      {state === null ? null : state.reachable ? (
        <p role="status" data-quick-lectures-added="" className="m-0 text-[18px] font-bold">
          {plural(state.count, "lecture")} added
        </p>
      ) : (
        <p role="status" data-quick-lectures-unreachable="" className="m-0 text-[15px] text-label-muted">
          The Rewind extension isn&apos;t answering in this browser, so recordings can&apos;t be counted here. You can still add .transcript.json files with Choose files.
        </p>
      )}
      <div>
        <button type="button" data-quick-recordings-skip="" className="btn btn-tertiary btn-lg" onClick={onSkip}>
          Skip this step
        </button>
      </div>
    </div>
  );
}
