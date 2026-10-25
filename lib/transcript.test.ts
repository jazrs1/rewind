import { describe, expect, it } from "vitest";
import type { Transcript } from "./schema";
import { ensureSentences, splitChunk } from "./transcript";

// Reference case for the shared splitting rule (the worker's JS test uses the same numbers).
// Text is 195 characters once whitespace collapses. Over 30 s that's 6.5 chars/s, faster
// than the 5 chars/s floor, so the span stays 30 s. The short "Ok." joins the last sentence.
const s1 = "The first idea is that a tree has a single root.";
const s2 = "The second idea is that every child has a parent.";
const s3 = "The third idea is that leaves have no children.";
const s4 = "The fourth idea is that height counts edges. Ok.";
const chunk = { start: 100, end: 130, speaker: "Dr. Lee", text: `${s1}  ${s2}\n${s3} ${s4}` };

describe("splitChunk", () => {
  it("places sentences by character position", () => {
    expect(splitChunk(chunk)).toEqual([
      { speaker: "Dr. Lee", start: 100, end: 107.5, text: s1 },
      { speaker: "Dr. Lee", start: 107.5, end: 115.2, text: s2, estimated: true },
      { speaker: "Dr. Lee", start: 115.2, end: 122.6, text: s3, estimated: true },
      { speaker: "Dr. Lee", start: 122.6, end: 130, text: s4, estimated: true },
    ]);
  });

  it("caps the span when the chunk is mostly silence", () => {
    // 195 characters at no slower than 5 chars/s is at most 39 s of speech, not 300 s.
    const out = splitChunk({ ...chunk, end: 400 });
    expect(out.map((x) => x.start)).toEqual([100, 109.8, 119.8, 129.4]);
    expect(out[3].end).toBe(400);
  });

  it("leaves chunks of 20 s or less alone", () => {
    expect(splitChunk({ ...chunk, end: 120 })).toEqual([
      { speaker: "Dr. Lee", start: 100, end: 120, text: `${s1} ${s2} ${s3} ${s4}` },
    ]);
  });

  it("merges short pieces into the next one", () => {
    const out = splitChunk({ start: 0, end: 60, speaker: null, text: "Okay. So. A heap is a complete tree. Right." });
    expect(out.map((s) => s.text)).toEqual(["Okay. So. A heap is a complete tree. Right."]);
  });
});

describe("ensureSentences", () => {
  const base: Transcript = {
    source: "zoom", recordingUrl: "", title: "t", recordedAt: null, durationSec: 130,
    segments: [{ start: 0, end: 100, speaker: "Dr. Lee", text: "Short." }, chunk],
  };

  it("splits long segments and keeps the originals as chunks", () => {
    const t = ensureSentences(base);
    expect(t.segments.map((s) => s.start)).toEqual([0, 100, 107.5, 115.2, 122.6]);
    expect(t.chunks).toHaveLength(2);
  });

  it("returns sentence-sized transcripts unchanged", () => {
    const t = { ...base, segments: [{ start: 0, end: 5, speaker: null, text: "Hi." }] };
    expect(ensureSentences(t)).toBe(t);
  });
});
