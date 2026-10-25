import { describe, expect, it } from "vitest";
import type { Transcription } from "../gemini";
import { buildSegments, labelWords, lecturerLabels, processRecording, stitch } from "./process";
import type { RecordingChunk, SlidePage } from "./types";

// Invented lecture, no real course content. Each turn's words are spread evenly over the turn.
type Turn = [label: string | null, start: number, end: number, text: string];
function fakeTranscription(turns: Turn[], opts: { untimed?: boolean } = {}): Transcription {
  const words: Transcription["words"] = [];
  for (const [, s, e, text] of turns) {
    const ws = text.split(/\s+/);
    const step = (e - s) / ws.length;
    ws.forEach((w, i) => words.push({ word: w, start: s + i * step, end: s + i * step + step * 0.9 }));
  }
  return {
    text: turns.map((t) => t[3]).join(" "),
    words,
    turns: turns.map(([speaker, start, end, text]) =>
      opts.untimed ? { speaker, start: null, end: null, text } : { speaker, start, end, text },
    ),
  };
}

const CHUNK0: Turn[] = [
  ["spk:0", 0, 20, "Today we cover binary heaps. A binary heap is a complete binary tree stored in an array, level by level."],
  ["spk:1", 21, 24, "Is the root always the smallest?"],
  ["spk:0", 25, 40, "Yes, in a min heap the root holds the smallest key. Insert adds at the end and sifts up."],
];
// Labels restart and swap: here the lecturer is spk:1 and a student is spk:0.
const CHUNK1: Turn[] = [
  ["spk:0", 0, 3, "Can you repeat that please?"],
  ["spk:1", 4, 30, "Sure. Hash tables map keys to buckets with a hash function. Collisions happen when two keys share one bucket."],
  ["spk:1", 33, 45, "Separate chaining keeps a linked list in each bucket."],
];

const chunks: RecordingChunk[] = [
  { index: 1, startSec: 300, mimeType: "audio/webm", path: "/tmp/fake-1.webm", durationSec: 300 },
  { index: 0, startSec: 0, mimeType: "audio/webm", path: "/tmp/fake-0.webm", recordedAt: "2026-10-27T17:45:00Z", durationSec: 300 },
];
const slides: SlidePage[] = [
  { deck: "Fake L10", page: 1, text: "Binary heaps: a complete binary tree stored in an array; insert sifts up" },
  { deck: "Fake L10", page: 2, text: "Hash tables: hash function, buckets, collisions, separate chaining with a linked list" },
  { deck: "Fake L10", page: 3, text: "Graphs: vertices, edges, adjacency matrix" },
];
const fakeTranscribe = async (path: string, options: { diarization: boolean }) => {
  calls.push({ path, options });
  return path.endsWith("-0.webm") ? fakeTranscription(CHUNK0) : fakeTranscription(CHUNK1);
};
let calls: { path: string; options: { diarization: boolean } }[] = [];

describe("processRecording", () => {
  it("transcribes each chunk in order with diarization, through the injected function", async () => {
    calls = [];
    await processRecording(chunks, slides, { transcribe: fakeTranscribe });
    expect(calls).toEqual([
      { path: "/tmp/fake-0.webm", options: { diarization: true } },
      { path: "/tmp/fake-1.webm", options: { diarization: true } },
    ]);
  });

  it("keeps only the lecturer, linked across chunks where the labels swap", async () => {
    const tape = await processRecording(chunks, slides, { transcribe: fakeTranscribe });
    expect(tape.segments.every((s) => s.speaker === "Lecturer")).toBe(true);
    const text = tape.segments.map((s) => s.text).join(" ");
    expect(text).toContain("binary heaps");
    expect(text).toContain("Hash tables");
    expect(text).not.toContain("root always");
    expect(text).not.toContain("repeat");
    expect(tape.segments.every((s) => s.estimated === undefined)).toBe(true);
  });

  it("stitches chunk offsets into real times and counts the dropped students", async () => {
    const tape = await processRecording(chunks, slides, { transcribe: fakeTranscribe });
    expect(tape.segments[0].start).toBe(0);
    const chain = tape.segments.find((s) => s.text.startsWith("Separate chaining"));
    expect(chain?.start).toBe(333);
    expect(chain?.end).toBeCloseTo(344.9, 1);
    // Student turns: 21-24 s in chunk 0 and 300-303 s in chunk 1 (last word ends at 90% of its slot).
    expect(tape.dropped.speakers).toBe(1);
    expect(tape.dropped.seconds).toBeCloseTo(2.8 + 2.8, 0);
  });

  it("fills the Transcript fields for a phone tape", async () => {
    const tape = await processRecording(chunks, slides, { transcribe: fakeTranscribe, title: "Fake lecture" });
    expect(tape).toMatchObject({ source: "phone", recordingUrl: "", title: "Fake lecture", recordedAt: "2026-10-27T17:45:00Z", durationSec: 600 });
  });

  it("matches the slides the lecturer talked about, with first and last times", async () => {
    const tape = await processRecording(chunks, slides, { transcribe: fakeTranscribe });
    expect(tape.slides.map((s) => s.page)).toEqual([1, 2]);
    expect(tape.slides[0]).toMatchObject({ deck: "Fake L10", page: 1, from: 0 });
    expect(tape.slides[0].to).toBeLessThanOrEqual(40);
    expect(tape.slides[1].from).toBeGreaterThanOrEqual(300);
    expect(tape.slides[1].to).toBeCloseTo(344.9, 1);
  });

  it("uses the last word's end when the last chunk's duration is unknown", async () => {
    const noDur = chunks.map((c) => ({ ...c, durationSec: null }));
    const tape = await processRecording(noDur, slides, { transcribe: fakeTranscribe });
    expect(tape.durationSec).toBeCloseTo(344.9, 1);
  });
});

describe("privacy guard (T11b)", () => {
  // n invented words, tagged so each speaker's text is easy to find.
  const say = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ") + ".";
  const chunk = (index: number): RecordingChunk => ({ index, startSec: index * 300, mimeType: "audio/webm", path: `/tmp/fake-${index}.webm`, durationSec: 300 });
  async function run(byChunk: Turn[][]) {
    const transcribe = async (path: string) => fakeTranscription(byChunk[Number(path.match(/fake-(\d+)/)![1])]);
    return processRecording(byChunk.map((_, i) => chunk(i)), [], { transcribe });
  }
  const textOf = (tape: { segments: { text: string }[] }) => tape.segments.map((s) => s.text).join(" ");

  it("drops a Q&A chunk where a student has the most speech, and records it", async () => {
    const tape = await run([
      [["spk:0", 0, 250, say("lect", 200)]], // lecturer stops 50 s before the boundary
      [["spk:0", 0, 150, say("student", 120)], ["spk:1", 150, 270, say("lectqa", 100)], ["spk:2", 270, 300, say("other", 25)]],
    ]);
    expect(tape.skipped).toEqual([{ index: 1, startSec: 300, endSec: 600, reason: "unclear speaker" }]);
    expect(textOf(tape)).toContain("lect0");
    expect(textOf(tape)).not.toContain("student");
    expect(textOf(tape)).not.toContain("other");
    expect(tape.segments.every((s) => s.start < 300)).toBe(true);
  });

  it("rescues a split chunk by continuity across the boundary", async () => {
    const qa: Turn[] = [["spk:1", 0.5, 150, say("cont", 120)], ["spk:0", 150, 240, say("student", 70)], ["spk:2", 240, 300, say("other", 50)]];
    const rescued = await run([[["spk:0", 0, 299.5, say("lect", 240)]], qa]);
    expect(rescued.skipped).toEqual([]);
    expect(textOf(rescued)).toContain("cont0");
    expect(textOf(rescued)).not.toContain("student");
    expect(textOf(rescued)).not.toContain("other");
    expect(rescued.dropped.speakers).toBe(2);

    // Same chunk, but the lecturer stopped well before the boundary: no continuity, dropped.
    const gap = await run([[["spk:0", 0, 250, say("lect", 200)]], qa]);
    expect(gap.skipped.map((s) => s.index)).toEqual([1]);
    expect(textOf(gap)).not.toContain("cont0");
  });

  it("continuity never rescues a speaker who isn't the chunk's top speaker", async () => {
    // A student starts right at the boundary with 40%, but the top speaker is someone else.
    const tape = await run([
      [["spk:0", 0, 299.5, say("lect", 240)]],
      [["spk:0", 0.5, 120.5, say("student", 100)], ["spk:1", 120.5, 255.5, say("lectb", 110)], ["spk:2", 255.5, 300, say("other", 35)]],
    ]);
    expect(tape.skipped.map((s) => s.index)).toEqual([1]);
    expect(textOf(tape)).not.toContain("student");
  });

  it("drops a chunk with three speakers and no majority", async () => {
    const tape = await run([
      [["spk:0", 0, 120, say("a", 100)], ["spk:1", 120, 225, say("b", 90)], ["spk:2", 225, 300, say("c", 60)]],
      [["spk:0", 0, 280, say("lect", 220)], ["spk:1", 285, 295, say("q", 8)]],
    ]);
    expect(tape.skipped).toEqual([{ index: 0, startSec: 0, endSec: 300, reason: "unclear speaker" }]);
    expect(textOf(tape)).toContain("lect0");
    for (const tag of ["a0", "b0", "c0", "q0"]) expect(textOf(tape)).not.toContain(tag);
    // Only the kept chunk's other speech is measured; the skipped chunk is in `skipped`.
    expect(tape.dropped.speakers).toBe(1);
  });
});

describe("speaker labels", () => {
  it("labelWords uses turn times, and word order when turns have none", () => {
    const timed = labelWords(fakeTranscription(CHUNK0));
    const untimed = labelWords(fakeTranscription(CHUNK0, { untimed: true }));
    expect(timed).toEqual(untimed);
    expect(timed.filter((l) => l === "spk:1")).toHaveLength(6);
  });

  it("lecturerLabels picks the label with the most speech in each chunk", () => {
    const words = stitch(
      [chunks[1], chunks[0]],
      [fakeTranscription(CHUNK0), fakeTranscription(CHUNK1)],
    );
    expect([...lecturerLabels(words)]).toEqual([[0, "spk:0"], [1, "spk:1"]]);
  });

  it("with no diarization at all, everything is the lecturer", () => {
    const t = fakeTranscription([[null, 0, 5, "Only one voice here."]]);
    t.turns = [];
    const words = stitch([{ index: 0, startSec: 10, mimeType: "audio/webm", path: "x" }], [t]);
    expect(words.map((w) => w.start)).toEqual([10, 11.25, 12.5, 13.75]);
    expect(lecturerLabels(words).get(0)).toBeNull();
  });
});

describe("buildSegments", () => {
  const w = (word: string, start: number, end: number, speaker = "A") => ({ word, start, end, speaker });

  it("splits at a speaker change", () => {
    const segs = buildSegments([w("Hi", 0, 0.5), w("there.", 0.6, 1), w("Question?", 1.1, 2, "B")]);
    expect(segs.map((s) => [s.speaker, s.text])).toEqual([["A", "Hi there."], ["B", "Question?"]]);
  });

  it("splits after a pause over 1.5 s, not at 1.5 s", () => {
    const segs = buildSegments([w("one", 0, 1), w("two", 2.5, 3), w("three", 4.6, 5)]);
    expect(segs.map((s) => s.text)).toEqual(["one two", "three"]);
  });

  it("splits at a sentence end only once the segment passes 12 s", () => {
    const words = [w("Short.", 0, 1), w("Still", 1.5, 2), w("going", 3, 4), w("on", 5, 6), w("and", 7, 8), w("on", 9, 10),
      w("and", 11, 12), w("done.", 12.5, 13), w("Next", 13.5, 14), w("part.", 14.5, 15)];
    const segs = buildSegments(words);
    expect(segs.map((s) => [s.start, s.end, s.text])).toEqual([
      [0, 13, "Short. Still going on and on and done."],
      [13.5, 15, "Next part."],
    ]);
  });
});
