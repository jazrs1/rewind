// Other people's names never leave the device in lecture lines (Q-SEC 3). Synthetic transcripts only.
import { describe, expect, it, vi } from "vitest";
import { buildPractice } from "./client.ts";
import { chunksOf, lectureChunks } from "./export.ts";
import { namesToStrip, stripNames } from "./names.ts";
import { parseRequest } from "./schema.ts";
import { course } from "./test-helpers.ts";
import type { QuickResponse } from "./types.ts";

const transcript = (segments: { speaker: string | null; text: string }[]) => ({
  source: "zoom" as const,
  recordingUrl: "https://ufl.zoom.us/rec/play/FAKE-1",
  title: "Lecture, Oct 22",
  recordedAt: "2026-10-22T17:48:09Z",
  durationSec: 3600,
  segments: segments.map((s, i) => ({ start: 3463 + i * 10, end: 3470 + i * 10, ...s })),
});

const LECTURE = transcript([
  { speaker: "Dr. Kapoor", text: "Good afternoon, I'm Dr. Kapoor, and today we cover hash tables and how a hash function maps keys to buckets in constant time." },
  { speaker: "Sam Lee", text: "SECRET-STUDENT-LINE is it always constant time?" },
  { speaker: "Dr. Kapoor", text: "Sam is right that it isn't always constant: with linear probing, a collision moves the key to the next free slot." },
  { speaker: "Dr. Kapoor", text: "Priya's question last week was about load factors, and Jordan Avery asked about resizing the table when it gets too full." },
  { speaker: null, text: "SECRET-UNLABELLED someone talking" },
  { speaker: "Dr. Kapoor", text: "We will mark the buckets as we go, and grace periods aside, the homework is due Friday." },
]);

describe("names in lecture lines", () => {
  it("another person's name, and its possessive, becomes \"a student\"; capitalised names only", () => {
    const names = namesToStrip({ speakers: ["Dr. Kapoor", "Sam Lee"], lecturer: "Dr. Kapoor" });
    expect(stripNames("Sam is right", names)).toBe("a student is right");
    expect(stripNames("Priya's question", names)).toBe("a student's question");
    expect(stripNames("Lee and Sam Lee agree", names)).toBe("a student and a student agree");
    expect(stripNames("the jordan effect", names)).toBe("the jordan effect");
  });

  it("keeps the lecturer's own name, and everyday words that are also names (Will, Mark, Grace, May)", () => {
    const names = namesToStrip({ speakers: ["Dr. Kapoor"], lecturer: "Dr. Kapoor" });
    expect(stripNames("I'm Dr. Kapoor. Will we Mark this? Grace periods end in May.", names)).toBe("I'm Dr. Kapoor. Will we Mark this? Grace periods end in May.");
    expect(names).not.toContain("Kapoor");
    expect(names).not.toContain("Lecturer");
  });

  it("a synthetic lecture: only the lecturer's lines, every other person's name replaced, the chunk still passes the route's check", () => {
    const chunks = lectureChunks(LECTURE, 0, ["Jordan Avery", "Avery, Jordan"]);
    const text = chunks.map((c) => c.text).join(" ");
    expect(text).toContain("a student is right that it isn't always constant");
    expect(text).toContain("a student's question last week");
    expect(text).toContain("and a student asked about resizing");
    expect(text).toContain("I'm Dr. Kapoor");
    expect(text).not.toMatch(/Sam|Priya|Jordan|Avery|\bLee\b|SECRET/);
    // The lines are the text (the route refuses a lecture whose text isn't its lines).
    for (const c of chunks) expect(parseRequest(JSON.stringify({ course, chunks: [c] })).ok).toBe(true);
  });

  it("no name, and no other speaker's line, reaches any request", async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ questions: [], refused: [] } satisfies QuickResponse));
    }) as unknown as typeof fetch;
    const files = { course, pages: [], transcripts: [LECTURE], people: ["Jordan Avery"] };
    expect(chunksOf(files).chunks.length).toBeGreaterThan(0);
    await buildPractice({ files, fetchFn });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toMatch(/Sam|Priya|Jordan|Avery|SECRET/);
  });
});

describe("M3: the lecturer's own name is never stripped, in any form", () => {
  it.each([
    ["Dr. Rivera", ["Alex Rivera"]],
    ["Rivera, Alex", ["Alex Rivera"]],
    ["Alex Rivera", ["Prof. Rivera", "Rivera, Alex"]],
  ])("lecturer %s, others %j", (lecturer, people) => {
    const names = namesToStrip({ speakers: [lecturer, "Sam Lee"], lecturer, people });
    const line = stripNames("As Alex Rivera said, Professor Rivera's example and Sam's question both use a heap.", names);
    expect(line).toContain("Alex Rivera");
    expect(line).toContain("Rivera's");
    expect(line).toContain("a student's question");
  });
});

describe("M2: another speaker who shares a word with the lecturer's name is still stripped", () => {
  it("shared surname: lecturer Dr. Lee, speaker Sam Lee", () => {
    const names = namesToStrip({ speakers: ["Dr. Lee", "Sam Lee"], lecturer: "Dr. Lee" });
    expect(stripNames("Sam is right", names)).toBe("a student is right");
  });
  it("shared first name: lecturer David Smith, speaker David Chen", () => {
    const names = namesToStrip({ speakers: ["David Smith", "David Chen"], lecturer: "David Smith" });
    expect(stripNames("Chen's question", names)).toBe("a student's question");
  });
});
