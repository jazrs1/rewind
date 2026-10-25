import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AnthropicClient, CLAUDE_OPUS, createLLM } from "../llm";
import { BAD_OCT22_Q2 } from "../questions/fixtures/bad-oct22-q2";
import { codeAppearsInOrder, generatePracticeSet, generateQuestion, locateInPassage, MAX_ATTEMPTS, practiceGroups, type QuestionMaterial, ruleTally } from "./generate";
import type { PipelineChunk } from "./types";

const COURSE = { code: "COP3530", name: "Data Structures and Algorithms" };
const SLIDE = { kind: "slide" as const, itemId: "file:1", fileId: 1, page: 19, deck: "8a - Graph Terminology" };

const MATERIAL: QuestionMaterial = {
  topic: "Graphs",
  examId: null,
  passages: [
    {
      id: "P1",
      label: "lecture 57:43 to 58:00",
      lines: [
        { start: 3463, text: "Next comes a joined-up graph, which isn't the same thing as a joined-up vertex." },
        { start: 3468, text: "We say an undirected graph is connected when each vertex can reach each other vertex by some path." },
        { start: 3480, text: "If you cannot get from A over to Q at all, the graph is not connected." },
      ],
      source: { kind: "lecture", itemId: "oct22", recordingUrl: "https://ufl.zoom.us/rec/play/x", start: 3463, end: 3490, title: "Oct 22" },
    },
    {
      id: "P2",
      label: 'slide 19 of "8a - Graph Terminology"',
      text: "Connected Graph An undirected graph counts as connected when some path links each pair of its vertices int diff = target - arr[i]; if(map.count(diff)) { result.first = map[diff]; result.second = i; break; }",
      source: SLIDE,
    },
  ],
  style: [{ itemId: "review:1", text: "An undirected graph has connected components {A, D} and {B, C, E}. Which statement is true? (A) ... (D) ..." }],
};

const NO_CODE = { language: "", lines: [], passage: "" };
const GOOD = {
  stem: "A graph has components {P, Q} and {R}. Which is true?",
  code: NO_CODE,
  choices: { A: "The graph is connected", B: "P and R are connected", C: "No path joins P and R", D: "Every vertex reaches all others" },
  answer: "C",
  explanation: "R is in a different component, so no path joins P and R.",
  quote: "an undirected graph is connected when each vertex can reach each other vertex by some path",
  quotePassage: "P1",
};
const CHECK_OK = {
  answer: "C",
  why: "R is alone.",
  unambiguous: true,
  uniqueUnderDefinition: true,
  standsAlone: true,
  optionsParallel: true,
  soundsLikeCourse: true,
  quoteSupports: true,
  problems: "",
};

/** Question prompts get questions[n], check prompts get checks[n] (the last one repeats). */
function fakeClaude(questions: object[], checks: object[]) {
  const calls: { kind: "question" | "check"; prompt: string; model: unknown }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          const prompt = (params.messages as { content: string }[])[0].content;
          const kind = prompt.startsWith("You check") ? "check" : "question";
          const pool = kind === "check" ? checks : questions;
          const n = calls.filter((c) => c.kind === kind).length;
          calls.push({ kind, prompt, model: params.model });
          return {
            model: params.model,
            stop_reason: "end_turn",
            stop_details: null,
            content: [{ type: "text", text: JSON.stringify(pool[Math.min(n, pool.length - 1)]) }],
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  } as unknown as AnthropicClient;
  return { client, calls };
}

describe("generateQuestion", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rewind-generate-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const llmWith = (client: AnthropicClient) => createLLM({ anthropic: client, cacheDir: join(dir, "llm"), usagePath: join(dir, "usage.jsonl") });

  it("keeps a question the blind check agrees with, citing the lecture line its quote starts on", async () => {
    const { client, calls } = fakeClaude([GOOD], [CHECK_OK]);
    const r = await generateQuestion(MATERIAL, { course: COURSE, id: "g1", llm: llmWith(client) });
    expect(r.status).toBe("kept");
    if (r.status !== "kept") return;
    expect(r.question).toMatchObject({ id: "g1", answer: "C", code: null, styleItemId: "review:1", check: { agreed: true, attempts: 1, reason: null } });
    expect(r.question.quoteSource).toMatchObject({ kind: "lecture", start: 3468 });
    expect(r.question.prompts).toEqual({ "question-gen": "question-gen@2", "answer-check": "answer-check@2" });
    expect(calls.map((c) => [c.kind, c.model])).toEqual([
      ["question", CLAUDE_OPUS],
      ["check", CLAUDE_OPUS],
    ]);
  });

  it("a reviewer's reason (regenerating a question) goes into the very first attempt", async () => {
    const { client, calls } = fakeClaude([GOOD], [CHECK_OK]);
    await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client), reason: "the options give it away: only one is about graphs" });
    expect(calls[0].prompt).toContain("An earlier attempt was rejected: the options give it away: only one is about graphs");
  });

  it("never shows the checker the key or the explanation, and gives it the style examples and rules", async () => {
    const { client, calls } = fakeClaude([GOOD], [CHECK_OK]);
    await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client) });
    const p = calls[1].prompt;
    expect(p).toContain("(C) No path joins P and R");
    expect(p).not.toContain(GOOD.explanation);
    expect(p).not.toMatch(/answer: C|correct answer/i);
    expect(p).toContain("connected components {A, D}");
    expect(p).toContain("Exactly one defensible answer under the PROBLEM's own definition");
  });

  it("rejects the bad Oct 22 Q2 in code even when the model check passes it, retries twice with the reason, then drops it", async () => {
    const bad = { ...BAD_OCT22_Q2, code: NO_CODE, quote: "int diff = target - arr[i]; if(map.count(diff))", quotePassage: "P2" };
    const { client, calls } = fakeClaude([bad], [{ ...CHECK_OK, answer: "B" }]);
    const r = await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client) });
    expect(r.status).toBe("dropped");
    if (r.status !== "dropped") return;
    expect(r.attempts).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(r.failures.map((f) => f.rule))).toEqual(new Set(["unique", "standalone", "options"]));
    expect(r.reason).toMatch(/2 valid answers/);
    expect(r.reason).toMatch(/professor's/);
    expect(r.reason).toMatch(/because…/);
    // Rejected in code: the check is never paid for.
    expect(calls.filter((c) => c.kind === "check")).toHaveLength(0);
    expect(calls[1].prompt).toContain("An earlier attempt was rejected: pair sum on [2, 7, 4, 9, 6] with target 13 has 2 valid answers");
  });

  it("rejects when the model check finds a rule broken, and keeps the retry that passes", async () => {
    const retried = { ...GOOD, stem: "A graph has components {P, Q} and {R, S}. Which is true?" };
    const { client, calls } = fakeClaude([GOOD, retried], [{ ...CHECK_OK, standsAlone: false, problems: "relies on a figure" }, CHECK_OK]);
    const r = await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client) });
    expect(r.status).toBe("kept");
    expect(r.attempts[0].failures).toEqual([{ rule: "standalone", reason: "the check found it refers to something not shown in the question (relies on a figure)" }]);
    expect(calls[2].prompt).toContain("An earlier attempt was rejected: the check found it refers to something not shown");
  });

  it("maps every model verdict to its rule", async () => {
    const { client } = fakeClaude([GOOD], [{ ...CHECK_OK, answer: "B", uniqueUnderDefinition: false, optionsParallel: false, soundsLikeCourse: false, quoteSupports: false }]);
    const r = await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client) });
    expect(new Set(r.attempts[0].failures.map((f) => f.rule))).toEqual(new Set(["check", "unique", "options", "style", "quote"]));
    expect(ruleTally([r]).rejectedBy).toMatchObject({ check: 3, unique: 3, options: 3, style: 3, quote: 3, standalone: 0 });
  });

  it("rejects a quote that isn't word for word, without paying for a check", async () => {
    const { client, calls } = fakeClaude([{ ...GOOD, quote: "a graph is connected when every vertex can reach every other vertex" }], [CHECK_OK]);
    const r = await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client) });
    expect(r.status).toBe("dropped");
    expect(r.attempts[0].failures[0].rule).toBe("quote");
    expect(calls.filter((c) => c.kind === "check")).toHaveLength(0);
  });

  it("keeps code copied from a passage, cited to it, and rejects code that isn't there", async () => {
    const withCode = {
      ...GOOD,
      stem: "What does the code shown store in result.first when the complement is found?",
      code: { language: "cpp", lines: ["int diff = target - arr[i];", "if(map.count(diff)) {", "  result.first = map[diff];", "  result.second = i;"], passage: "P2" },
      choices: { A: "The index of the complement", B: "The current index i", C: "The value of diff", D: "The value of arr[i]" },
      answer: "A",
      quote: "result.first = map[diff]; result.second = i; break;",
      quotePassage: "P2",
    };
    const { client } = fakeClaude([withCode], [{ ...CHECK_OK, answer: "A" }]);
    const r = await generateQuestion(MATERIAL, { course: COURSE, llm: llmWith(client) });
    expect(r.status).toBe("kept");
    if (r.status === "kept") expect(r.question.code).toEqual({ language: "cpp", lines: withCode.code.lines, source: SLIDE });

    const invented = { ...withCode, code: { ...withCode.code, lines: ["int x = 0;", "x += map.size();", "return x;"] } };
    const { client: c2 } = fakeClaude([invented], [{ ...CHECK_OK, answer: "A" }]);
    const r2 = await generateQuestion(MATERIAL, { course: COURSE, llm: createLLM({ anthropic: c2, cacheDir: join(dir, "llm2"), usagePath: join(dir, "usage.jsonl") }) });
    expect(r2.attempts[0].failures.map((f) => f.rule)).toContain("code");
  });
});

describe("codeAppearsInOrder", () => {
  const slideText = "Two Sum for (int i = 0; i < n; i++) { int diff = target - arr[i]; if(map.count(diff)) //check if complement is present { result.first = map[diff]; break; } map[arr[i]] = i; }";
  it("accepts the slide's lines in order, with an inline comment left out and brace-only lines", () => {
    expect(codeAppearsInOrder(["for (int i = 0; i < n; i++) {", "  int diff = target - arr[i];", "  if(map.count(diff))", "  {", "    result.first = map[diff]; break;", "  }"], slideText)).toBe(true);
  });
  it("rejects reordered, edited or invented lines", () => {
    expect(codeAppearsInOrder(["int diff = target - arr[i];", "for (int i = 0; i < n; i++) {"], slideText)).toBe(false);
    expect(codeAppearsInOrder(["int diff = arr[i] - target;", "if(map.count(diff))"], slideText)).toBe(false);
    expect(codeAppearsInOrder(["{", "}"], slideText)).toBe(false);
  });
});

describe("locateInPassage", () => {
  it("narrows a lecture quote to the line it starts on, and returns null when absent", () => {
    expect(locateInPassage("cannot get from A over to Q", MATERIAL.passages[0])).toMatchObject({ kind: "lecture", start: 3480 });
    expect(locateInPassage("when some path links each pair", MATERIAL.passages[1])).toEqual(SLIDE);
    expect(locateInPassage("a tree is a connected acyclic graph", MATERIAL.passages[1])).toBeNull();
  });
});

describe("practice sets", () => {
  const long = (s: string) => `${s} `.repeat(12);
  const chunk = (deck: string, page: number, text: string, role: PipelineChunk["role"] = "lecture"): PipelineChunk => ({
    id: `${deck}#${page}`,
    text,
    role,
    source: role === "review" ? { kind: "document", itemId: deck, fileId: 9, page, name: deck } : { kind: "slide", itemId: deck, fileId: 1, page, deck },
  });
  const chunks = [
    chunk("Graphs", 1, long("graph vertex edge")),
    chunk("Graphs", 2, long("adjacency matrix")),
    chunk("Graphs", 3, "Summary: graph terms, a short closing slide."),
    chunk("Hashing", 1, long("hash collision")),
    chunk("Reviews", 1, "Which representation uses O(V^2) space? (A) list (B) matrix", "review"),
  ];
  const fakeEmbed = async (texts: string[]) => texts.map((t) => [t.includes("hash") ? 1 : 0, t.includes("graph") || t.includes("matrix") ? 1 : 0, 0.1]);

  it("makes one group per deck when no exams are known, skipping near-empty pages", async () => {
    const groups = await practiceGroups({ course: COURSE, exams: [], chunks, perGroup: 5 }, fakeEmbed);
    expect(groups.map((g) => [g.topic, g.anchors.map((a) => a.id)])).toEqual([
      ["Graphs", ["Graphs#1", "Graphs#2"]],
      ["Hashing", ["Hashing#1"]],
    ]);
  });

  it("makes one group per exam with topics, anchored on the closest pages", async () => {
    const exam = {
      id: "exam2",
      courseId: "c",
      name: { value: "Exam 2", quote: "Exam 2", itemId: "s" },
      date: { value: null, quote: null, itemId: null },
      location: { value: null, quote: null, itemId: null },
      format: { value: null, quote: null, itemId: null },
      notesRule: { value: null, quote: null, itemId: null },
      topics: { value: ["hash tables"], quote: "hash tables", itemId: "s" },
      searched: [],
    };
    const groups = await practiceGroups({ course: COURSE, exams: [exam], chunks, perGroup: 1 }, fakeEmbed);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ examId: "exam2", examName: "Exam 2", topic: "hash tables" });
    expect(groups[0].anchors.map((a) => a.id)).toEqual(["Hashing#1"]);
  });

  it("falls back to Canvas pages with role \"page\" when the course has no slides or files, never review pages as style", async () => {
    const page = (url: string, k: number, text: string, role: PipelineChunk["role"] = "page"): PipelineChunk => ({
      id: `page:${url}#c${k}`,
      text,
      role,
      source: { kind: "page", itemId: `page:${url}`, pageUrl: url, title: url, href: `https://x/pages/${url}` },
    });
    const pages = [
      page("lesson-3", 1, long("the span of u and v")),
      page("lesson-3", 2, long("linear combination")),
      page("office-hours", 1, long("zoom hours"), "admin"),
      page("unit-1-review", 1, long("Answer Key: 1-5: BCACA"), "review"),
      page("lesson-4", 1, "Too short."),
    ];
    const groups = await practiceGroups({ course: COURSE, exams: [], chunks: pages, perGroup: 1 }, fakeEmbed);
    expect(groups.map((g) => [g.topic, g.anchors.map((a) => a.id)])).toEqual([["lesson-3", ["page:lesson-3#c2"]]]);
    // With slides present, pages stay out of the anchors.
    const mixed = await practiceGroups({ course: COURSE, exams: [], chunks: [...chunks, ...pages], perGroup: 5 }, fakeEmbed);
    expect(mixed.flatMap((g) => g.anchors).some((a) => a.source.kind === "page")).toBe(false);

    let dir = "";
    try {
      dir = await mkdtemp(join(tmpdir(), "rewind-pages-"));
      const q = { ...GOOD, quote: "linear combination linear combination", quotePassage: "P2" };
      const { client, calls } = fakeClaude([q], [CHECK_OK]);
      const llm = createLLM({ anthropic: client, cacheDir: join(dir, "llm"), usagePath: join(dir, "usage.jsonl") });
      const out = await generatePracticeSet({ course: COURSE, exams: [], chunks: pages, perGroup: 2 }, { llm, embed: fakeEmbed });
      expect(out.questions.length).toBeGreaterThanOrEqual(1);
      expect(out.questions[0]).toMatchObject({ topic: "lesson-3", styleItemId: null, quoteSource: { kind: "page", pageUrl: "lesson-3" } });
      // The page's next chunk is the second passage; the review page's answer key is not a style example.
      expect(calls[0].prompt).toContain('[P2] page "lesson-3"');
      expect(calls[0].prompt).not.toContain("BCACA");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generates per group with review-role style examples and the next page as material", async () => {
    let dir = "";
    try {
      dir = await mkdtemp(join(tmpdir(), "rewind-set-"));
      const q = { ...GOOD, quote: "adjacency matrix adjacency matrix adjacency matrix", quotePassage: "P1" };
      const { client, calls } = fakeClaude([q], [CHECK_OK]);
      const llm = createLLM({ anthropic: client, cacheDir: join(dir, "llm"), usagePath: join(dir, "usage.jsonl") });
      const out = await generatePracticeSet({ course: COURSE, exams: [], chunks, perGroup: 1, groups: ["Graphs"] }, { llm, embed: fakeEmbed });
      expect(out.results.map((r) => (r.result.status === "dropped" ? r.result.reason : "kept"))).toEqual(["kept"]);
      expect(out.questions).toHaveLength(1);
      expect(out.questions[0]).toMatchObject({ id: "graphs-1", topic: "Graphs", styleItemId: "Reviews" });
      expect(calls[0].prompt).toContain("Which representation uses O(V^2) space?");
      expect(calls[0].prompt).toContain('[P2] slide 3 of "Graphs"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
