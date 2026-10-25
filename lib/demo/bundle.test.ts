import { mergeAttempts } from "../course/attempts";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleHistory } from "../attempts/examples.ts";
import { createGemini } from "../gemini.ts";
import { createLLM } from "../llm.ts";
import { BUNDLE_DIR, bundleAssets, parseBundle, readDemoBundle, resolveAsset, type DemoBundleFile } from "./bundle.ts";
import { assertNotDemo, isDemoMode } from "./guard.ts";
import { DEMO_TAPE_NOTE, DEMO_TAPE_STATS_NOTE, buildDemoTape } from "./tape.ts";

const committed = (): DemoBundleFile => JSON.parse(readFileSync(join(process.cwd(), "public", BUNDLE_DIR, "course.json"), "utf8"));

describe("the committed bundle (public/demo/course)", () => {
  it("parses into one practice set per lecture, slides under /demo/course/", async () => {
    const b = await readDemoBundle(process.cwd());
    expect(b).not.toBeNull();
    expect(b!.label).toBe("Demo course, materials used with Professor Kapoor's permission");
    expect(b!.sets.map((s) => s.seed.set)).toEqual(["Lecture practice, Oct 13", "Lecture practice, Oct 20", "Lecture practice, Oct 22"]);
    for (const s of b!.sets) {
      expect(s.seed.course.code).toBe("COP3530");
      for (const q of s.seed.questions) {
        expect(q.match.slide.image).toMatch(/^\/demo\/course\/slides\/l\d{8}-q\d+\.png$/);
        expect(q.segments.length).toBeGreaterThan(0);
        expect(q.match.start).toBeLessThan(q.match.end);
      }
    }
  });
});

describe("hosted clips", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("a hosted question plays its file only when public/demo/media/<questionId>.mp4 is there, from the clip start", async () => {
    root = mkdtempSync(join(tmpdir(), "rewind-bundle-"));
    mkdirSync(join(root, "public", BUNDLE_DIR), { recursive: true });
    copyFileSync(join(process.cwd(), "public", BUNDLE_DIR, "course.json"), join(root, "public", BUNDLE_DIR, "course.json"));
    const none = await readDemoBundle(root);
    expect(none!.sets.map((s) => s.hosted)).toEqual([[], [], []]);
    expect(bundleAssets(none!).every((u) => u.startsWith("/demo/course/slides/"))).toBe(true);

    // One of Oct 20's two hosted clips is there; the missing one (q6) shows its transcript.
    mkdirSync(join(root, "public", "demo", "media"), { recursive: true });
    for (const id of ["l20261020-q1"]) writeFileSync(join(root, "public", "demo", "media", `${id}.mp4`), "");
    const two = await readDemoBundle(root);
    const set = two!.sets[1];
    const match = (id: string) => set.seed.questions.find((q) => q.id === id)!.match;
    expect(set.hosted).toEqual([
      { questionId: "l20261020-q1", src: "/demo/media/l20261020-q1.mp4", offset: match("l20261020-q1").start, end: match("l20261020-q1").end },
    ]);
    expect(two!.sets[0].hosted).toEqual([]);
    // The offline cache lists only the files that are there.
    const media = bundleAssets(two!).filter((u) => u.startsWith("/demo/media/"));
    expect(media).toEqual(["/demo/media/l20261020-q1.mp4"]);
  });

  it("carries a poll or answer slide's revealsAnswer into the seed", async () => {
    const b = (await readDemoBundle(process.cwd()))!;
    const flagged = b.sets.flatMap((s) => s.seed.questions).filter((q) => q.match.slide.revealsAnswer);
    expect(flagged.map((q) => q.id)).toEqual(["l20261013-q2", "l20261020-q3"]);
  });

  it("returns null when there is no bundle", async () => {
    root = mkdtempSync(join(tmpdir(), "rewind-bundle-"));
    expect(await readDemoBundle(root)).toBeNull();
  });
});

describe("parseBundle", () => {
  it("rejects asset paths that climb out of the bundle or point elsewhere", () => {
    expect(resolveAsset("demo/course", "./slides/a.png")).toBe("/demo/course/slides/a.png");
    expect(() => resolveAsset("demo/course", "../../private/demo/seed.json")).toThrow();
    expect(() => resolveAsset("demo/course", "slides//a.png")).toThrow();
    expect(() => resolveAsset("demo/course", "https://example.com/a.png")).toThrow();
  });

  it("fails loudly on a malformed bundle", () => {
    const ok = committed();
    expect(() => parseBundle({ ...ok, format: "rewind-demo/1" })).toThrow(/format/);
    expect(() => parseBundle({ ...ok, label: "" })).toThrow(/label/);
    const badAnswer = structuredClone(ok);
    badAnswer.sets[0].questions[0].answer = "D";
    badAnswer.sets[0].questions[0].choices = badAnswer.sets[0].questions[0].choices.slice(0, 3);
    expect(() => parseBundle(badAnswer)).toThrow(/answer D/);
    const outside = structuredClone(ok);
    outside.sets[0].questions[0].lines.push({ start: outside.sets[0].questions[0].clip.end + 5, end: outside.sets[0].questions[0].clip.end + 9, text: "x" });
    expect(() => parseBundle(outside)).toThrow(/outside the clip/);
    const hostedLater = structuredClone(ok);
    hostedLater.sets[0].questions.reverse();
    expect(() => parseBundle(hostedLater)).toThrow(/hosted-clip questions come first/);
    const hostedSwapped = structuredClone(ok);
    hostedSwapped.sets[0].hosted = [hostedSwapped.sets[0].hosted[1], hostedSwapped.sets[0].hosted[0]];
    expect(() => parseBundle(hostedSwapped)).toThrow(/come first, in order/);
    const hostedPath = structuredClone(ok);
    hostedPath.sets[0].hosted = ["../../x"];
    expect(() => parseBundle(hostedPath)).toThrow(/lowercase/);
    const reveals = structuredClone(ok) as unknown as { sets: { questions: { slide: { revealsAnswer: unknown } }[] }[] };
    reveals.sets[0].questions[0].slide.revealsAnswer = "yes";
    expect(() => parseBundle(reveals)).toThrow(/revealsAnswer/);
  });
});

describe("the demo Course tape", () => {
  it("has 8 to 10 stops, one per lecture and topic, each with its lecture's date and its questions' clips", async () => {
    const bundle = (await readDemoBundle(process.cwd()))!;
    const { tape, clips, examples } = buildDemoTape(bundle);
    expect(tape.stops.length).toBeGreaterThanOrEqual(8);
    expect(tape.stops.length).toBeLessThanOrEqual(10);
    // Clip excerpts add no stress: without topic-stats.json nothing glows, and the route comes from what is missed.
    const bare = buildDemoTape({ ...bundle, stats: undefined }).tape;
    expect(bare.notes[0]).toBe(DEMO_TAPE_NOTE);
    expect(bare.glowFrom).toBe("flags");
    expect(bare.stops.every((s) => s.stressed.heat === 0)).toBe(true);
    // With it, the full recordings' minutes and flags make stops glow, each from its own evidence.
    expect(bundle.stats).toBeDefined();
    expect(tape.notes[0]).toBe(DEMO_TAPE_STATS_NOTE);
    expect(tape.glowFrom).toBe("lectures");
    expect(tape.stops.some((s) => s.stressed.heat > 0)).toBe(true);
    for (const s of tape.stops) if (s.stressed.heat > 0) expect(s.stressed.evidence.some((e) => e.source === "The full recordings"), s.id).toBe(true);
    expect(tape.totals.lectures).toBe(3);
    const all = bundle.sets.flatMap((s) => s.seed.questions.map((q) => ({ q, day: s.id })));
    // Every question is on exactly one stop: its topic's, dated its lecture, with its clip.
    expect(tape.stops.flatMap((s) => s.practiceIds).sort()).toEqual(all.map((x) => x.q.id).sort());
    for (const stop of tape.stops) {
      const mine = all.filter((x) => stop.practiceIds.includes(x.q.id));
      expect(new Set(mine.map((x) => `${x.day} ${x.q.topic}`)), stop.topic).toEqual(new Set([`${mine[0].day} ${stop.topic}`]));
      expect(stop.firstTaughtAt, stop.topic).toBe(mine[0].day);
      // Its clip, or an overlapping one it was merged into (the builder dedupes overlapping clips).
      for (const { q } of mine) expect(stop.clips.some((c) => q.match.start >= c.start && q.match.start < c.end), q.id).toBe(true);
      expect(clips[stop.clips[0].id].segments.length).toBeGreaterThan(0);
    }
    // A stop holding hosted-clip questions plays the first of them first.
    for (const s of bundle.sets) {
      const first = s.seed.questions[0];
      const stop = tape.stops.find((x) => x.practiceIds.includes(first.id))!;
      expect(stop.clips[0].start, first.id).toBe(first.match.start);
    }
    const history = exampleHistory(examples, "2026-10-24T12:00:00Z");
    expect(history.some((a) => !a.correct)).toBe(true);
    expect(new Set(history.map((a) => a.topic)).size).toBeGreaterThan(1);
    const merged = mergeAttempts(tape, history.map((a) => ({ ...a, example: true })));
    expect(merged.route.steps.length).toBeGreaterThan(0);
  });
});

describe("demo mode guard", () => {
  it("is on for production builds, Vercel and REWIND_DEMO=1, off in dev and tests", () => {
    expect(isDemoMode({ NODE_ENV: "production" })).toBe(true);
    expect(isDemoMode({ NODE_ENV: "development", VERCEL: "1" })).toBe(true);
    expect(isDemoMode({ NODE_ENV: "development", REWIND_DEMO: "1" })).toBe(true);
    expect(isDemoMode({ NODE_ENV: "development" })).toBe(false);
    expect(isDemoMode({ NODE_ENV: "test" })).toBe(false);
  });

  it("blocks model calls in demo mode", () => {
    expect(() => assertNotDemo("Calling Gemini", { NODE_ENV: "production" })).toThrow(/demo mode/);
    expect(() => assertNotDemo("Calling Gemini", { NODE_ENV: "development" })).not.toThrow();
  });

  it("the Gemini and Claude clients refuse to start in demo mode, even with a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rewind-guard-"));
    vi.stubEnv("REWIND_DEMO", "1");
    vi.stubEnv("GEMINI_API_KEY", "not-a-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "not-a-key");
    try {
      const gemini = createGemini({ cacheDir: dir });
      await expect(gemini.generateText("gemini-x", "hi")).rejects.toThrow(/demo mode/);
      const llm = createLLM({ cacheDir: dir, usagePath: join(dir, "usage.jsonl"), geminiCacheDir: dir });
      await expect(llm.generateText({ provider: "anthropic", model: "claude-sonnet-5-5" }, "hi")).rejects.toThrow(/demo mode/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
