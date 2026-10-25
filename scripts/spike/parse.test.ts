import { describe, expect, it } from "vitest";
import { parsePanel, parseTime, parseVtt, parseZoomHtml, toTranscript } from "./parse";

// Made-up lecture text; no real course content.
const vtt = `WEBVTT

1
00:00:05.120 --> 00:00:09.870
Dr. Lee: Good morning, today is trees.

2
00:00:10.000 --> 00:00:14.500
Dr. Lee: Note: a heap is not a search tree.

3
00:00:15.000 --> 00:00:18.000
Student One: Is that on the quiz?

4
00:43:40.000 --> 00:43:45.250
Dr. Lee: A right rotation fixes left-left.
`;

describe("parseTime", () => {
  it("handles m:ss, mm:ss, h:mm:ss and fractions", () => {
    expect(parseTime("4:05")).toBe(245);
    expect(parseTime("43:40")).toBe(2620);
    expect(parseTime("1:02:15")).toBe(3735);
    expect(parseTime("00:00:05.120")).toBeCloseTo(5.12);
  });
});

describe("parseVtt", () => {
  it("reads cues and recurring speakers", () => {
    const s = parseVtt(vtt);
    expect(s).toHaveLength(4);
    expect(s[0]).toEqual({ start: 5.12, end: 9.87, speaker: "Dr. Lee", text: "Good morning, today is trees." });
    expect(s[1].text).toBe("Note: a heap is not a search tree.");
    // A one-off prefix is not trusted as a speaker.
    expect(s[2]).toMatchObject({ speaker: null, text: "Student One: Is that on the quiz?" });
    expect(s[3].start).toBe(2620);
  });
});

describe("parsePanel", () => {
  // Same shape as a copy of the Zoom panel; made-up text and names.
  const copy =
    "https://example.invalid/rec/play/abc\n" +
    "Ada Lee00:00:04Good morning, today is graphs.Guest Speaker00:01:10Hi, I study tutoring tools." +
    "Ada Lee00:07:22Thanks! Now, the algorithm is called Dijkstra" +
    "Ada Lee00:29:24It finds shortest paths.Take care. Resume autoscrolling    Edit Save " +
    "Pat Student  18:02  PS yes0 Replies Sam Other  01:09:05  SO is this on the exam?0 Replies";

  it("splits on speaker names taken from the text and cuts the UI and chat", () => {
    const { segments, recordingUrl } = parsePanel(copy, 6081);
    expect(recordingUrl).toBe("https://example.invalid/rec/play/abc");
    expect(segments.map((x) => [x.start, x.end, x.speaker])).toEqual([
      [4, 70, "Ada Lee"],
      [70, 442, "Guest Speaker"],
      [442, 1764, "Ada Lee"],
      [1764, 6081, "Ada Lee"],
    ]);
    // "Dijkstra" stays in the text: the speaker is the known name, not the capitalized words before it.
    expect(segments[2].text).toBe("Thanks! Now, the algorithm is called Dijkstra");
    expect(segments[3].text).toBe("It finds shortest paths.Take care.");
    expect(JSON.stringify(segments)).not.toMatch(/Pat Student|Replies|autoscrolling/);
  });

  it("fails clearly on text without timestamps", () => {
    expect(() => parsePanel("just some words\nmore words")).toThrow(/No timestamped chunks/);
  });
});

describe("toTranscript", () => {
  it("builds the shared format", () => {
    const t = toTranscript(vtt, { filename: "private/spike/lecture 12.vtt" });
    expect(t).toMatchObject({ source: "zoom", recordingUrl: "", title: "lecture 12", recordedAt: null, durationSec: 2625.25 });
  });
});

describe("parseZoomHtml", () => {
  // Same shape as a saved Zoom page; made-up text.
  const page = `
    <span class="vjs-time-range-duration">01:00:00</span>
    <ul class="transcript-list">
      <li class="transcript-list-item" aria-label="Dr. Lee, 0 hours 0 minutes 4 seconds, Welcome back &amp; hello."><span class="time">00:00:04</span></li>
      <li class="transcript-list-item" aria-label="Dr. Lee, 0 hours 7 minutes 22 seconds, Today: AVL trees."></li>
      <li class="transcript-list-item" aria-label="Student, 0 hours 59 minutes 50 seconds, Is this on the quiz?"></li>
    </ul>`;

  it("reads every item's time from aria-label", () => {
    const { segments, durationSec } = parseZoomHtml(page);
    expect(durationSec).toBe(3600);
    expect(segments).toEqual([
      { start: 4, end: 442, speaker: "Dr. Lee", text: "Welcome back & hello." },
      { start: 442, end: 3590, speaker: "Dr. Lee", text: "Today: AVL trees." },
      { start: 3590, end: 3600, speaker: "Student", text: "Is this on the quiz?" },
    ]);
  });
});

describe("toTranscript sentence times", () => {
  it("splits long panel chunks into estimated sentences and keeps the chunks", () => {
    // 69 chars in a 60 s chunk is slower than 5 chars/s, so the span is capped at 13.8 s.
    const src = "Dr. Lee00:00:00This first sentence is the opening. This second sentence comes later.Dr. Lee00:01:00Next.";
    const t = toTranscript(src, { filename: "transcript.txt", durationSec: 65 });
    expect(t.segments.map((s) => [s.start, s.estimated ?? false])).toEqual([[0, false], [7.2, true], [60, false]]);
    expect(t.chunks).toHaveLength(2);
  });
});

describe("regressions", () => {
  // Spike run 1: without --duration the last chunk (most of the lecture) had no end and was never searched.
  it("refuses panel text without a duration", () => {
    expect(() => toTranscript("Ada Lee00:00:04Hello there, class.", { filename: "transcript.txt" })).toThrow(/--duration/);
  });
});
