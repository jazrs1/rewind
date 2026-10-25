"use client";

// Plays one course-tape clip (the stop's best moment: a practice question's rewind from the matcher or
// the pipeline, a radar flag, or his longest stretch on the topic) with the Rewind player, from the
// student's Zoom recording. Without the lecture lines for it, it says so instead of playing blind.
// Demo mode (ClipMedia): a hosted clip when there is one, else the clip's transcript.

import { createContext, useContext } from "react";
import { RewindPlayer } from "@/components/rewind/RewindPlayer";
import type { Clip, ClipContext } from "@/lib/course/types";
import type { SourceConfig } from "@/lib/player/types";

/** Demo mode: hosted clips by tape clip id; null (the default) plays from the student's Zoom recording. */
export const ClipMedia = createContext<Record<string, { src: string; offset: number }> | null>(null);

/** `frameless`: with no slide to show, no picture frame at all (never an empty box); the transcript says it. */
export function ClipPlayer({ clip, context, extensionId, accent, frameless = false }: { clip: Clip; context: ClipContext | undefined; extensionId: string; accent?: string; frameless?: boolean }) {
  const media = useContext(ClipMedia);
  if (!context || !context.segments.length) {
    return <p className="m-0 text-[15px] text-label-muted">The lecture lines for this moment weren&apos;t found, so it can&apos;t play here.</p>;
  }
  const hosted = media?.[clip.id];
  const source: SourceConfig = media
    ? hosted
      ? { kind: "hosted-media", src: hosted.src, offset: hosted.offset }
      : { kind: "none" }
    : { kind: "zoom-embed", extensionId, recordingUrl: clip.recordingUrl };
  return (
    <div data-clip-start={clip.start} data-clip-end={clip.end}>
      <RewindPlayer
        source={source}
        clip={{ start: clip.start, end: clip.end }}
        segments={context.segments}
        lecturer={context.lecturer}
        setup={clip.setup ?? null}
        exampleStart={clip.exampleStart ?? null}
        rewoundText={`Rewound to where ${context.lecturer} explains it`}
        accent={accent}
        frameless={frameless}
      />
    </div>
  );
}
