// Quick build with PDFs (slides, study guides), and the rule that no student data is ever sent. Synthetic data only:
// the PDFs are made here (lib/quick/test-pdf.ts), the export is invented, the model is the fake.
import { LIMITS } from "./types";
import { getDocumentProxy } from "unpdf";
import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "../demo/tutor-store.ts";
import { buildPractice } from "./client.ts";
import { chunksOf, pdfChunks, pickChunks, readFile } from "./export.ts";
import { peopleOf } from "./graded.ts";
import { pdfFile, readPdfPages, type PdfLike } from "./pdf.ts";
import { parseRequest } from "./schema.ts";
import { bankToSeed, sourceLine } from "./seed.ts";
import { quickLLM, writeQuestions } from "./service.ts";
import { parseBank } from "./store.ts";
import { countingModel, course, request, send, deps } from "./test-helpers.ts";
import { makePdf } from "./test-pdf.ts";
import type { QuickChunk, QuickQuestion, QuickResponse } from "./types.ts";

const TEXT = [
  "A hash table maps keys to buckets and finds a key in constant time on average when the table is not too full.",
  "With linear probing, a collision moves the key to the next free slot in the table and keeps looking from there.",
  "A graph is connected if there is a path between every pair of vertices, however long the path might be.",
];

const slide = (page: number, text = `${TEXT[page % 3]} ${TEXT[(page + 1) % 3]}`, deck = "Week 3 Hashing"): QuickChunk => ({ id: `d0p${page}c0`, kind: "slide", title: deck, text, doc: { deck, page } });
const parse = (body: unknown) => parseRequest(JSON.stringify(body));
const why = (body: unknown) => {
  const r = parse(body);
  return r.ok ? null : r.why;
};

describe("PDF chunks", () => {
  it("keep each page's number from the PDF through the chunks the route accepts", async () => {
    const bytes = makePdf([{ lines: [TEXT[0], TEXT[1]] }, { image: true }, { lines: [TEXT[2], TEXT[0]] }], { landscape: true });
    const f = pdfFile("Week 3 Hashing.pdf", await readPdfPages((await getDocumentProxy(bytes)) as unknown as PdfLike));
    const chunks = pdfChunks([f]);
    expect(chunks.map((c) => [c.kind, c.doc])).toEqual([
      ["slide", { deck: "Week 3 Hashing", page: 1 }],
      ["slide", { deck: "Week 3 Hashing", page: 3 }],
    ]);
    expect(chunks[1].text).toContain("A graph is connected");
    const { chunks: ok, dropped } = chunksOf({ course, pages: [], transcripts: [], pdfs: [f] });
    expect(ok).toHaveLength(2);
    expect(dropped).toBe(0);
    expect(pickChunks(ok)).toHaveLength(2);
  });

  it("split a long page at about 800 characters, every piece on the same page", () => {
    const long = Array.from({ length: 12 }, (_, i) => `${TEXT[i % 3]}`).join(" ");
    const chunks = pdfChunks([{ deck: "Study guide", kind: "document", pages: [{ page: 7, text: long }], skipped: 0 }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.doc).toEqual({ deck: "Study guide", page: 7 });
      expect(c.text.length).toBeLessThanOrEqual(800);
      expect(parse({ course, chunks: [c] }).ok).toBe(true);
    }
  });
});

describe("the request schema with PDF chunks", () => {
  it("takes slides and documents with their { deck, page }", () => {
    expect(parse({ course, chunks: [slide(12), { ...slide(3), id: "d1p3c0", kind: "document" }] }).ok).toBe(true);
  });

  it("refuses a PDF chunk without its page, with other keys, a deck that isn't its title, or a page that isn't a whole number", () => {
    const bare = { ...slide(1), doc: undefined }; // JSON drops it: a slide with no doc
    expect(why({ course, chunks: [bare] })).toBe("doc keys");
    expect(why({ course, chunks: [{ ...slide(1), doc: { deck: "Week 3 Hashing", page: 1, user_id: 7 } }] })).toBe("doc keys");
    expect(why({ course, chunks: [{ ...slide(1), doc: { deck: "Other", page: 1 } }] })).toBe("doc deck");
    expect(why({ course, chunks: [{ ...slide(1), doc: { deck: "Week 3 Hashing", page: 1.5 } }] })).toBe("doc page");
    expect(why({ course, chunks: [{ ...slide(1), doc: { deck: "Week 3 Hashing", page: 0 } }] })).toBe("doc page");
    expect(why({ course, chunks: [{ ...slide(1), doc: { deck: "<b>x</b>", page: 1 }, title: "<b>x</b>" }] })).toBe("chunk title");
  });

  it("refuses a page or a lecture that carries a file, and a slide that carries a recording", () => {
    expect(why({ course, chunks: [{ id: "p1", kind: "page", title: "M", text: TEXT[0], doc: { deck: "M", page: 1 } }] })).toBe("page with a file");
    expect(why({ course, chunks: [{ ...slide(1), lecture: { recordingUrl: "https://x.zoom.us/rec/1", recordedAt: "2026-10-22T17:48:09Z", segments: [] } }] })).toBe("page with a recording");
  });
});

describe("PDF questions", () => {
  it("name their place: \"Slide 12 · <deck>\" for slides, \"Page 3 · <deck>\" for a document, and have no clip", async () => {
    expect(sourceLine({ kind: "slide", title: "Week 3 Hashing", deck: "Week 3 Hashing", page: 12 })).toBe("Slide 12 · Week 3 Hashing");
    expect(sourceLine({ kind: "document", title: "Study guide", deck: "Study guide", page: 3 })).toBe("Page 3 · Study guide");
    expect(sourceLine({ kind: "page", title: "Module 3" })).toBe("Page: Module 3");

    const { model } = countingModel();
    const out = await writeQuestions(request([slide(12)]), { llm: quickLLM({ model, store: memoryStore(), now: () => 0 }), count: 1 });
    expect(out.questions).toHaveLength(1);
    const q = out.questions[0];
    expect(q.source).toEqual({ kind: "slide", title: "Week 3 Hashing", deck: "Week 3 Hashing", page: 12 });
    expect(slide(12).text).toContain(q.quote);

    const seed = bankToSeed({ v: 1, course, builtAt: "", questions: [q] }).questions[0];
    expect(seed.quick).toMatchObject({ label: "Slide 12 · Week 3 Hashing", where: 'slide 12 of "Week 3 Hashing"', quote: q.quote });
    expect(seed.match.start).toBeNull();
    // Stored and read back on the device, the bank keeps it.
    expect(parseBank(JSON.stringify({ v: 1, course, builtAt: "", questions: [q] }))?.questions).toHaveLength(1);
    expect(parseBank(JSON.stringify({ v: 1, course, builtAt: "", questions: [{ ...q, source: { kind: "slide", title: "x" } }] }))).toBeNull();
  });

  it("a quote that isn't word for word in the page's text drops the question", async () => {
    const reply = {
      stem: "What does linear probing do on a collision?",
      code: { language: "", lines: [], passage: "" },
      choices: { A: "Moves to the next free slot", B: "Starts over", C: "Drops the key", D: "Doubles the table" },
      answer: "A",
      explanation: "The slide says so.",
      quote: "linear probing always doubles the table on every collision",
      quotePassage: "P1",
    };
    const model = vi.fn(async (prompt: string) => ({
      reply: /^You check practice questions/.test(prompt) ? { answer: "A", why: "x", unambiguous: true, uniqueUnderDefinition: true, standsAlone: true, optionsParallel: true, soundsLikeCourse: true, quoteSupports: true, problems: "" } : reply,
      inputTokens: 10,
      outputTokens: 10,
    }));
    const out = await writeQuestions(request([slide(2)]), { llm: quickLLM({ model, store: memoryStore(), now: () => 0 }), count: 1 });
    expect(out.questions).toEqual([]);
    expect(out.refused.length).toBe(1);
  });

  it("count against the same daily questions through the route", async () => {
    let t = Date.parse("2026-10-24T12:00:00Z");
    const d = deps({ now: () => (t += 61_000) });
    // Each slide its own words (the fake asks about words 5 to 7), so no two questions are the same.
    const chunks = Array.from({ length: 12 }, (_, i) => slide(i + 1, `So this is slide ${i + 1}: ${TEXT[i % 3]} ${TEXT[(i + 1) % 3]}`));
    let cookie: string | null = null;
    let total = 0;
    for (let i = 0; i < Math.ceil(LIMITS.questionsPerDay / 5) + 1; i++) {
      const r = await send({ course, chunks }, d, cookie ? { cookie } : {});
      cookie = r.cookie ?? cookie;
      total += r.json.questions?.length ?? 0;
    }
    expect(total).toBe(LIMITS.questionsPerDay);
  });
});

describe("never sends student data", () => {
  // A full synthetic CourseExport with every kind of student data Canvas can carry.
  const STUDENT = {
    exportedAt: "2026-10-24T21:00:00Z",
    user: { id: 991177, name: "SECRET-NAME Student", email: "secret.student@example.edu", login_id: "secretlogin" },
    user_id: 991177,
    course: { id: 424242, name: "Data Structures (Demo)", course_code: "FAKE1001", enrollments: [{ user_id: 991177, computed_current_score: 87.5, type: "student" }] },
    pages: [
      { page_id: 1, title: "Module 3: Hash tables", url: "m3", body: `<p>${TEXT[0]}</p><p>${TEXT[1]}</p>`, last_edited_by: { id: 991177, display_name: "SECRET-NAME" } },
    ],
    files: [{ id: 7, display_name: "SECRET-FILE.pdf", user_id: 991177 }],
    modules: [{ id: 3, name: "Module 3", items: [{ title: "HW 3", completion_requirement: { completed: true } }] }],
    assignments: [{ id: 5, name: "SECRET-HW", points_possible: 100, due_at: "2026-10-30T23:59:00Z", score: 93, rubric: [{ points: 10, description: "SECRET-RUBRIC" }], submission: { score: 93, grade: "A-", user_id: 991177 } }],
    announcements: [{ title: "SECRET-ANNOUNCEMENT", message: "<p>Exam on Friday</p>" }],
    submissions: [{ assignment_id: 5, user_id: 991177, score: 93, grade: "A-", entered_grade: "93", submission_comments: [{ comment: "SECRET-COMMENT", author_name: "SECRET-TA" }], user: { name: "SECRET-NAME" } }],
    grades: { current_score: 87.5, final_grade: "B+" },
    errors: [],
  };
  const KEYS = ["user_id", "user", "email", "login_id", "submission", "submissions", "score", "grade", "grades", "points", "points_possible", "rubric", "comment", "submission_comments", "due_at", "enrollments", "last_edited_by", "files", "assignments", "announcements"];
  const VALUES = ["991177", "SECRET", "secret.student", "secretlogin", "87.5", "93", "A-", "B+", "2026-10-30"];

  it("captures every request body built from a full export and finds no student key or value in any of them", async () => {
    const parse = () => ({ body: { nodeType: 1, tagName: "BODY", childNodes: [{ nodeType: 1, tagName: "P", childNodes: [{ nodeType: 3, nodeValue: `${TEXT[0]} ${TEXT[1]}`, childNodes: [] }] }] } }) as unknown as Document;
    const got = readFile(STUDENT, parse);
    expect(got?.kind).toBe("course");
    if (got?.kind !== "course") return;
    const slides = pdfFile("Week 3 Hashing.pdf", [{ page: 1, text: `${TEXT[1]} ${TEXT[2]}`, landscape: true }]);
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ questions: [] as QuickQuestion[], refused: [] } satisfies QuickResponse));
    }) as unknown as typeof fetch;
    // And the student's own graded work among the picked PDFs (Q-SEC 2): named, scored, never sent.
    const graded = pdfFile("HW 3 SECRET-NAME Student.pdf", [{ page: 1, text: `Score: 93/100\n${TEXT[0]} SECRET-ANSWER`, landscape: false }]);
    await buildPractice({ files: { course: got.course, pages: got.pages, transcripts: [], pdfs: [slides, graded], people: peopleOf(STUDENT) }, fetchFn });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      const keys = new Set<string>();
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object")
          for (const [k, v] of Object.entries(x)) {
            keys.add(k);
            walk(v);
          }
      };
      walk(JSON.parse(b));
      for (const k of KEYS) expect(keys.has(k), `key ${k}`).toBe(false);
      for (const v of VALUES) expect(b, `value ${v}`).not.toContain(v);
      expect([...keys].every((k) => ["course", "code", "name", "chunks", "id", "kind", "title", "text", "doc", "deck", "page"].includes(k))).toBe(true);
    }
  });

  it("the route's schema refuses any unknown key, wherever it is", () => {
    const ok = { course, chunks: [slide(1)] };
    expect(parse(ok).ok).toBe(true);
    expect(why({ ...ok, user_id: 991177 })).toBe("keys");
    expect(why({ ...ok, course: { ...course, user_id: 991177 } })).toBe("course");
    expect(why({ ...ok, chunks: [{ ...slide(1), score: 93 }] })).toBe("chunk keys");
    expect(why({ ...ok, chunks: [{ ...slide(1), doc: { deck: "Week 3 Hashing", page: 1, grade: "A-" } }] })).toBe("doc keys");
  });
});
