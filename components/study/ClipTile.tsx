"use client";

// A lecture moment in the study session's chat: a 16:9 tile that plays in place, with nothing laid over the picture,
// and one caption row under it: the tape chip ("Oct 22 · 57:43 ◀◀"), then the professor's line there, word for word.
// Where a hosted clip (public/demo/media) covers the moment the tile is that video, its poster the frame at that
// second; where none does, there is no empty player: the slide (SlidePreview) if there is one, then the caption row.

import { useRef, useState } from "react";
import { Play } from "@/components/icons";
import { dayLabel, type ChipMoment } from "@/components/tutor/Chips";
import { formatTime } from "@/lib/format";

const SHELL: Record<number, string> = { 1: "bg-tape-1 text-white", 2: "bg-tape-2 text-deck", 3: "bg-tape-3 text-deck", 4: "bg-tape-4 text-deck" };

export function ClipTile({
  questionId,
  start,
  quote,
  moment,
  media,
  poster,
  notHosted,
}: {
  /** The question this moment belongs to (its topic's stop), for the page's own checks. */
  questionId?: string;
  start: number;
  quote: string;
  moment: ChipMoment | null | undefined;
  /** The hosted clip that covers this moment (its file starts at `offset` seconds of the lecture), or null. */
  media: { src: string; offset: number } | null;
  /** The slide shown (as a SlidePreview) when no hosted clip covers the moment. */
  poster?: string;
  /** A line under the quote when nothing plays here (outside the demo: where the clip does play). */
  notHosted?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const at = media ? Math.max(0, start - media.offset) : 0;
  const when = `${moment?.date ? `${dayLabel(moment.date)} · ` : ""}${formatTime(start)}`;
  const label = `Play the lecture from ${moment?.date ? `${dayLabel(moment.date)}, ` : ""}${formatTime(start)}`;
  const play = () => {
    const v = video.current;
    if (!v) return;
    v.currentTime = at;
    setPlaying(true);
    void v.play().catch(() => setPlaying(false));
  };
  return (
    <figure data-clip-tile="" data-question={questionId} data-date={moment?.date ?? undefined} data-start={start} data-hosted={media ? "" : undefined} className="m-0 flex flex-col gap-2">
      {/* The picture alone: nothing laid over the video (only the play control, until it plays). */}
      {media ? (
        <div data-clip-video="" className="relative aspect-video w-full max-w-[560px] overflow-hidden rounded-[10px] bg-deck shadow-[inset_0_0_0_1px_var(--color-tutor-line)]">
          <video
            ref={video}
            // The fragment makes the browser show that second's frame as the poster before anything plays.
            src={`${media.src}#t=${at}`}
            preload="metadata"
            playsInline
            controls={playing}
            onPause={() => setPlaying(false)}
            className="absolute inset-0 size-full object-cover"
          />
          {!playing ? (
            <button
              type="button"
              aria-label={label}
              onClick={play}
              className="absolute top-1/2 left-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-label bg-deck/80 text-label transition-transform duration-150 hover:-translate-y-[calc(50%+2px)]"
            >
              <Play />
            </button>
          ) : null}
        </div>
      ) : poster ? (
        <SlidePreview src={poster} alt="" />
      ) : null}
      {/* One caption row under it: the tape chip, then the professor's line there, word for word, cream on the deck. */}
      <figcaption className="flex flex-col gap-1">
        <span className="text-[15px] leading-[26px]">
          <span data-tape-chip="" className={`mr-2 inline-flex h-[26px] items-center gap-1.5 rounded-md pr-2 pl-1 align-top ${SHELL[moment?.shell ?? 1]}`}>
            <span className="inline-flex h-5 items-center rounded-[3px] bg-label px-2 font-hand text-[18px] leading-none font-bold text-deck">{when}</span>
            <span aria-hidden="true" className="text-xs font-bold">
              ◀◀
            </span>
          </span>
          <q data-clip-quote="" className="text-label">
            {quote}
          </q>
        </span>
        {!media && notHosted ? (
          <span data-not-hosted="" className="text-xs leading-snug text-slide-ink">
            {notHosted}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** A slide in the chat: its page render, under the words that point to it (its chip follows). */
export function SlidePreview({ src, alt }: { src: string; alt: string }) {
  if (!src) return null;
  return (
    <figure data-slide-preview="" className="m-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="aspect-video w-full max-w-[360px] rounded-md bg-white object-contain shadow-[0_2px_6px_rgb(0_0_0/0.35)]" />
    </figure>
  );
}
