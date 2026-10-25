// Stand-in for the pipeline's front half (T17: download → extract → chunk) until it lands: makes
// ExtractedDoc[] / PipelineChunk[] / PipelineTranscript[] in the contract's shapes from the files
// already on disk, so generate → check → retrieve can run end to end on COP3530:
//   - slide decks: private/spike/*.pdf (one chunk per page, Canvas file ID and href from the export)
//   - lectures: private/fixtures/zoom-recording.html (Oct 22) and private/lectures/*.transcript.json
//   - style examples: no past review is downloaded yet, so John's hand-written practice questions
//     (private/spike/questions.txt, one per line) stand in as review-role chunks. Replace with the
//     real reviews' chunks once T17 writes private/pipeline/<COURSE>/chunks.json.
// Dev only: reads private/, never writes there.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { FIXTURE_LECTURE_RECORDED_AT } from "../fixture-lecture.ts";
import { extractText } from "unpdf";
import { toTranscript } from "../../scripts/spike/parse.ts";
import type { Transcript } from "../schema.ts";
import { ensureSentences } from "../transcript.ts";
import type { ExtractedDoc, PipelineChunk, PipelineTranscript } from "./types.ts";

export interface LocalCourse {
  course: { id: number; code: string; name: string };
  docs: ExtractedDoc[];
  chunks: PipelineChunk[];
  transcripts: PipelineTranscript[];
}

export interface LocalPaths {
  privateDir?: string;
  courseCode?: string;
  /** Slide PDFs. Default <private>/spike. */
  deckDir?: string;
  /** Only decks whose name contains one of these. */
  decks?: string[];
  /** Transcripts: .transcript.json, or a saved Zoom page .html. Default: the Oct 22 page + private/lectures/*.transcript.json. */
  transcripts?: string[];
  /** Stand-in style examples (one question per line). Default <private>/spike/questions.txt. */
  styleQuestions?: string | null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** One chunk per page for decks; one per line for the stand-in review. */
export function chunksFromDocs(docs: ExtractedDoc[], courseId: number | null): PipelineChunk[] {
  const href = (fileId: number | null, page: number) =>
    courseId && fileId ? `https://ufl.instructure.com/courses/${courseId}/files/${fileId}#page=${page}` : undefined;
  return docs.flatMap((d) =>
    d.pages
      .filter((p) => p.text.trim())
      .map((p): PipelineChunk => ({
        id: `${d.itemId}#p${p.page}`,
        text: p.text,
        role: d.role,
        source:
          d.role === "lecture"
            ? { kind: "slide", itemId: d.itemId, fileId: d.fileId ?? 0, page: p.page, deck: d.name, href: href(d.fileId, p.page) }
            : { kind: "document", itemId: d.itemId, fileId: d.fileId ?? 0, page: p.page, name: d.name, href: href(d.fileId, p.page) },
      })),
  );
}

/** COP3530's lectures on disk: the saved Oct 22 Zoom page and private/lectures/*.transcript.json. */
export async function defaultTranscriptPaths(priv = "private"): Promise<string[]> {
  return [
    join(priv, "fixtures", "zoom-recording.html"),
    ...(await readdir(join(priv, "lectures")).catch(() => [] as string[])).filter((f) => f.endsWith(".transcript.json")).sort().map((f) => join(priv, "lectures", f)),
  ];
}

/** Transcripts from .transcript.json files or saved Zoom pages (.html); missing files are skipped. */
export async function loadTranscripts(paths: string[], priv = "private"): Promise<PipelineTranscript[]> {
  const transcripts: PipelineTranscript[] = [];
  for (const p of paths) {
    const src = await tryRead(p);
    if (!src) continue;
    let t: Transcript;
    if (p.endsWith(".transcript.json")) t = ensureSentences(JSON.parse(src) as Transcript);
    else {
      // The saved Oct 22 page has no recording URL or date; the spike keeps the URL in transcript.txt's first line.
      const url = (await tryRead(join(priv, "spike", "transcript.txt")))?.split("\n")[0].trim();
      t = { ...toTranscript(src, { filename: p, url, title: "Lecture, Oct 22" }), recordedAt: FIXTURE_LECTURE_RECORDED_AT };
    }
    transcripts.push({ ...t, id: slug(basename(p).replace(/(\.transcript)?\.[^.]+$/, "")) });
  }
  return transcripts;
}

export async function loadLocalCourse(paths: LocalPaths = {}): Promise<LocalCourse> {
  const priv = paths.privateDir ?? "private";
  const code = paths.courseCode ?? "COP3530";
  const exp = JSON.parse((await tryRead(join(priv, `${code}.course.json`))) ?? "null") as {
    course: { id: number; name: string | null; course_code: string | null };
    files: { id: number; display_name?: string }[];
  } | null;
  const fileIdOf = (deck: string) => exp?.files.find((f) => (f.display_name ?? "").replace(/\.pdf$/i, "") === deck)?.id ?? null;

  const docs: ExtractedDoc[] = [];
  const deckDir = paths.deckDir ?? join(priv, "spike");
  const pdfs = (await readdir(deckDir)).filter((f) => f.toLowerCase().endsWith(".pdf") && (!paths.decks || paths.decks.some((d) => f.includes(d)))).sort();
  for (const f of pdfs) {
    const { text } = await extractText(new Uint8Array(await readFile(join(deckDir, f))), { mergePages: false });
    const deck = f.replace(/\.pdf$/i, "");
    const fileId = fileIdOf(deck);
    docs.push({
      itemId: fileId ? `file:${fileId}` : `local:${slug(deck)}`,
      fileId,
      name: deck,
      role: "lecture",
      pages: text.map((t, i) => ({ page: i + 1, text: t.replace(/\s+/g, " ").trim() })),
    });
  }

  const style = paths.styleQuestions === null ? null : await tryRead(paths.styleQuestions ?? join(priv, "spike", "questions.txt"));
  if (style) {
    const lines = style.split("\n").map((l) => l.trim()).filter(Boolean);
    docs.push({
      itemId: "local:hand-written-practice",
      fileId: null,
      name: "Hand-written practice questions (stand-in for past reviews)",
      role: "review",
      pages: lines.map((text, i) => ({ page: i + 1, text })),
    });
  }

  const transcripts = await loadTranscripts(paths.transcripts ?? (await defaultTranscriptPaths(priv)), priv);

  return {
    course: { id: exp?.course.id ?? 0, code: exp?.course.course_code ?? code, name: exp?.course.name ?? code },
    docs,
    chunks: chunksFromDocs(docs, exp?.course.id ?? null),
    transcripts,
  };
}
