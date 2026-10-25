// What "Build my practice" says when the route can't help (off, unavailable, capped, erroring): never "Done: 0
// questions". And the notice when the PDFs look like another course's. Fakes only: the real route handler with fake
// deps (no key, no network), or canned responses; synthetic files.
import { describe, expect, it } from "vitest";
import { downStore } from "../demo/tutor-store.ts";
import { buildPractice, COULDNT_BUILD, outcomeOf, STOP_TEXT, type BuildResult } from "./client.ts";
import { codesIn, courseCodeOf, courseMismatch, mismatchText } from "./course-match.ts";
import type { ExportFiles } from "./export.ts";
import { handleQuickGenerate } from "./route.ts";
import { course, deps, pageChunk } from "./test-helpers.ts";
import type { QuickModel } from "./service.ts";

const files: ExportFiles = { course, pages: Array.from({ length: 6 }, (_, i) => ({ title: `Module ${i}`, text: pageChunk(i).text })), transcripts: [] };
/** The real route as fetch, with these deps. */
const viaRoute = (d: ReturnType<typeof deps>): typeof fetch =>
  (async (url: string, init?: RequestInit) => handleQuickGenerate(new Request(`https://rewindit.org${url}`, { ...init, headers: { ...(init?.headers as object), "x-real-ip": "203.0.113.7" } }), d)) as unknown as typeof fetch;
const canned = (status: number, body: object): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const said = async (fetchFn: typeof fetch) => outcomeOf(await buildPractice({ files, fetchFn }));
const LIMIT = "Couldn't build practice right now (today's limit reached). Your files never left this device; try again tomorrow.";

describe("when the build route can't help, it never says \"Done: 0 questions\"", () => {
  it("off (404 from the real route with the flag off)", async () => {
    expect(await said(viaRoute(deps({ enabled: false })))).toEqual({ status: null, alert: COULDNT_BUILD, failed: true });
  });

  it("unavailable (503: the counter store is down, so nothing is called)", async () => {
    const d = deps({ store: downStore("no kv") });
    expect(await said(viaRoute(d))).toEqual({ status: null, alert: COULDNT_BUILD, failed: true });
    expect(d.calls.model).toBe(0);
  });

  it("capped: today's limit (429 visitor, ip-day, day-budget) says so; the minute's cap says that", async () => {
    for (const error of ["visitor", "ip-day", "day-budget"]) expect(await said(canned(429, { error, questions: [], refused: [{ reason: error }] }))).toEqual({ status: null, alert: LIMIT, failed: true });
    expect((await said(canned(429, { error: "rate", questions: [], refused: [] }))).alert).toBe("Couldn't build practice right now (too many tries this minute). Your files never left this device; try again in a minute.");
  });

  it("erroring: a 502, a dropped connection, or a model that fails every question (a 200 with only error refusals)", async () => {
    expect(await said(canned(502, { error: "error" }))).toEqual({ status: null, alert: COULDNT_BUILD, failed: true });
    expect(await said((async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch)).toEqual({ status: null, alert: COULDNT_BUILD, failed: true });
    const broken: QuickModel = async () => Promise.reject(new Error("overloaded"));
    const d = deps({ model: () => broken });
    expect(await said(viaRoute(d))).toEqual({ status: null, alert: COULDNT_BUILD, failed: true });
  });

  it("the $4 day spent mid-batch (a 200 with only budget refusals) is the limit; the store failing mid-batch is unavailable", async () => {
    expect(await said(canned(200, { questions: [], refused: [{ reason: "budget" }, { reason: "budget" }] }))).toEqual({ status: null, alert: LIMIT, failed: true });
    expect(await said(canned(200, { questions: [], refused: [{ reason: "store" }] }))).toEqual({ status: null, alert: COULDNT_BUILD, failed: true });
  });

  it("but text the checks refused is not the route's trouble: it says there wasn't enough to write from", async () => {
    expect(await said(canned(200, { questions: [], refused: [{ reason: "checks" }, { reason: "quote" }] }))).toEqual({ status: null, alert: STOP_TEXT.nothing, failed: false });
  });

  it("some questions, then a cap: \"Done: N\", and why it stopped", async () => {
    const r: BuildResult = { questions: Array.from({ length: 5 }, () => ({}) as never), stopped: "limit" };
    expect(outcomeOf(r)).toEqual({ status: "Done: 5 questions.", alert: STOP_TEXT.limit, failed: false });
    // And the real route with the fake model: questions, no alert.
    expect(await said(viaRoute(deps()))).toMatchObject({ status: expect.stringMatching(/^Done: [1-9]\d* questions?\.$/), alert: null, failed: false });
  });

  it("only the daily cap says tomorrow; everything else says a minute", () => {
    expect(outcomeOf({ questions: [], stopped: "limit" }).alert).toMatch(/try again tomorrow\.$/);
    for (const stopped of ["rate", "unavailable", "off", "error"] as const) expect(outcomeOf({ questions: [], stopped }).alert).toMatch(/try again in a minute\.$/);
  });

  it("no outcome ever reads \"Done: 0\"", () => {
    for (const stopped of ["limit", "rate", "unavailable", "off", "error", "nothing", null] as const) expect(outcomeOf({ questions: [], stopped }).status ?? "").not.toMatch(/Done: 0/);
  });
});

describe("PDFs from another course", () => {
  const pdf = (deck: string, first = "Some slide text") => ({ deck, pages: [{ page: 1, text: first }] });

  it("finds course codes, with or without a space or dash, and the course's own code", () => {
    expect(codesIn("COP3530 Lecture 3, MAP 2302 and EEL-3701C")).toEqual(["COP3530", "MAP2302", "EEL3701"]);
    expect(codesIn("FAKE1001 and ABC12345")).toEqual([]);
    expect(courseCodeOf("MAP2302-0123(12345)")).toBe("MAP2302");
    expect(courseCodeOf("FAKE1001")).toBeNull();
  });

  it("a synthetic mismatch: COP3530 slides with a MAP2302 course export", () => {
    const m = courseMismatch("MAP2302", [pdf("COP3530 Lecture 3 Hashing"), pdf("Week 4", "COP 3530 Data Structures\nTrees"), pdf("Week 5")]);
    expect(m).toEqual({ found: "COP3530", expected: "MAP2302" });
    expect(mismatchText(m!)).toBe("These files look like they're from COP3530, not MAP2302. Build anyway?");
  });

  it("no notice when any PDF names the course, when none names a course, or when the course has no code", () => {
    expect(courseMismatch("MAP2302", [pdf("COP3530 notes"), pdf("MAP2302 Lecture 1")])).toBeNull();
    expect(courseMismatch("MAP2302", [pdf("Week 3 Hashing"), pdf("Study guide")])).toBeNull();
    expect(courseMismatch("My course", [pdf("COP3530 Lecture 3")])).toBeNull();
    expect(courseMismatch("MAP2302", [])).toBeNull();
  });
});
