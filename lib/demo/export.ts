// The demo bundle from the course pipeline's output (pure; scripts/demo/export-demo.ts does the
// reading and writing). Only lecture practice goes in: questions not tied to an exam whose clip is
// in their own lecture, grouped by that lecture. Every question is rebuilt field by field from an
// allowlist, so nothing else in the pipeline's output (Canvas ids and links, recording links, file
// ids, check verdicts, prompts, other students' lines) can reach the committed bundle.

import { dominantSpeaker, shownSlide } from "../pipeline/retrieve.ts";
import type { PipelineOutput, PipelineTranscript, PracticeQuestion } from "../pipeline/types.ts";
import { BUNDLE_FORMAT, PERMISSION_LABEL, type DemoBundleFile, type DemoQuestionFile, type DemoSetFile } from "./bundle.ts";
import { TOPIC_STATS_FILE } from "./topic-stats.ts";
import { mergeTopics, slideTopic, type TopicTable } from "./topics.ts";

/** The only keys a bundle question has (the unit test holds course.json to these). */
export const QUESTION_KEYS = ["id", "topic", "stem", "code", "choices", "answer", "explanation", "quote", "slide", "clip", "lines"] as const;
export const SLIDE_KEYS = ["deck", "page", "kind", "image"] as const;
/**
 * Slide keys that ship only when set: revealsAnswer marks a poll or answer slide (never shown before the student
 * answers); quoteDeck and quotePage say where the quote's words are when that isn't the slide shown (a lecture
 * question shows its lecture's own deck, lib/pipeline/lecture-slides.ts, while its quote may be from a Discussion deck).
 */
export const OPTIONAL_SLIDE_KEYS = ["revealsAnswer", "quoteDeck", "quotePage"] as const;
export const CLIP_KEYS = ["start", "end", "setup"] as const;
export const LINE_KEYS = ["start", "end", "text"] as const;
/**
 * The only files the bundle directory holds besides course.json and slides/: written by other scripts
 * (scripts/demo/precompute-tutor.ts, scripts/demo/topic-stats.ts, the Ask tab's saved replies), kept across a re-export.
 */
export const BUNDLE_KEEP = ["tutor.json", TOPIC_STATS_FILE, "ask.json"] as const;

export interface ExportOptions {
  /**
   * The frozen demo ids: pipeline question id → demo id ("l20261013-q1"). An id never changes once
   * given; a new question gets its lecture's next free number, and a removed one leaves a gap.
   */
  ids: Record<string, string>;
  /** Demo ids of the questions with a hosted clip (public/demo/media/<id>.mp4); each lecture's come first, in this order. */
  hosted: string[];
  /** Demo ids whose slide shows the answer, by hand (on top of the ones answerSlide finds). */
  revealsAnswer?: string[];
  /** A slide's (or page's) text, for answerSlide and the topic; null when it isn't known. */
  slideText?: (deck: string, page: number) => string | null;
  /** The topics table (scripts/demo/demo-topics.json): each question's topic from its slide's title. */
  topics: TopicTable;
  lecturer: { name: string; short: string };
  /** The slide image a question's slide or page is rendered to (the pipeline's file name), or null if there is none. */
  slideImage: (q: PracticeQuestion) => string | null;
  /** Rendered page kind per image name (slides-kinds.json); a missing one follows the citation. */
  pageKinds?: Record<string, "slide" | "page">;
  /** Students' names the lecturer says (kept out of the repo); students who spoke are added from the transcripts. */
  redactNames?: string[];
  /** Pipeline question id → why it's left out (a slide someone looked at and turned down). */
  exclude?: Record<string, string>;
}

export interface ExportResult {
  bundle: DemoBundleFile;
  /** Slide images to copy: the pipeline's image name → the bundle's (relative to the bundle directory). */
  slides: { from: string; to: string }[];
  /** Questions left out, by reason (counts only). */
  skipped: Record<string, number>;
  /** opts.ids plus the ids given to new questions (write it back, so they stay). */
  ids: Record<string, string>;
  /** Demo ids whose slide has no text title, so their topic is from the table's hand list. */
  untitled: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-13" → "Oct 13". */
const short = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
/** UTC date of the recording: every lecture here is a midday class, so it's the Eastern date too. */
const dayOf = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

/** Words a line may not carry: anyone else who spoke in a lecture (students), by each part of their name. */
export function otherSpeakerNames(transcripts: PipelineTranscript[], lecturers: Set<string>): string[] {
  const names = new Set<string>();
  for (const t of transcripts) for (const s of t.segments) if (s.speaker && !lecturers.has(s.speaker)) for (const w of s.speaker.split(/\s+/)) if (w.length >= 3) names.add(w);
  return [...names].sort();
}

/**
 * The "## Names to redact" list in private/demo-clips.md: each "- Name" entry (a note in brackets
 * after it is dropped), plus each word of a multi-word name. Throws when the section is missing or
 * lists nobody, so an export can never run unredacted. scripts/deploy/scan.py reads it the same way.
 */
export function parseRedactList(markdown: string): string[] {
  const parts = markdown.split(/^## Names to redact[ \t]*$/m);
  if (parts.length < 2) throw new Error('demo-clips.md has no "## Names to redact" section: refusing to export unredacted text');
  const names = new Set<string>();
  for (const m of parts[1].split(/^## /m)[0].matchAll(/^[-*][ \t]+(.+)$/gm)) {
    const name = m[1].replace(/\(.*?\)/g, " ").trim();
    if (!/^[\p{L}][\p{L}'’ .-]*$/u.test(name)) throw new Error(`demo-clips.md: "${m[1].trim()}" isn't a name entry`);
    names.add(name.replace(/\s+/g, " "));
    for (const w of name.split(/[\s.]+/)) if ([...w].length >= 2) names.add(w);
  }
  if (!names.size) throw new Error('demo-clips.md lists no "## Names to redact": refusing to export unredacted text');
  return [...names].sort();
}

/** Text with every listed name (whole words, any case) replaced by "a student". */
export function redact(text: string, names: string[]): string {
  if (!names.length) return text;
  // Longest first, so "Jordan Smith" goes as one; one pass, so a replacement is never matched again.
  // Letter-aware edges (\b doesn't know "ë" is a letter).
  const alt = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return text.replace(re, "a student");
}

/** Words that may sit between "he" and its verb ("he then explains"). */
const ADVERBS = new Set(["also", "then", "now", "just", "already", "still", "first", "again", "always", "never", "often", "quickly", "briefly", "next", "finally"]);
const IRREGULAR: Record<string, string> = { is: "are", was: "were", has: "have", does: "do", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't", "doesn't": "don't" };
/** A present-tense verb after "he", for "they": "is" → "are", "explains" → "explain", "goes" → "go"; anything else as it is. */
function forThey(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  if (/(?:ss|sh|ch|x|z|o)es$/.test(lower)) return verb.slice(0, -2);
  if (/[^aeiou]ies$/.test(lower)) return `${verb.slice(0, -3)}y`;
  if (/[a-z]{2}[^su]s$/.test(lower)) return verb.slice(0, -1);
  return verb;
}

/**
 * A setup line ("Where Kapoor is") with the lecturer named, never "he": the first "he" (when the name isn't already
 * there) becomes the name, every other he/him/his/himself becomes they/them/their/themself, and the verb after a
 * "they" agrees ("he is" → "they are"). Text in quotation marks is left as it is. No model; transcript lines never
 * go through this.
 */
export function namedSetup(setup: string, name: string): string {
  let named = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(setup);
  const SWAP: Record<string, string> = { he: "they", him: "them", his: "their", himself: "themself" };
  return setup
    .split(/("[^"]*"|“[^”]*”|‘[^’]*’)/)
    .map((part, i) => {
      if (i % 2) return part; // a quoted span
      // Words (with an apostrophe ending, "he's") and what's between them; a word is at an odd index.
      const tok = part.split(/([A-Za-z]+(?:['’][a-z]+)?)/);
      let verbAt = -1; // the token whose verb follows a new "they"
      for (let k = 1; k < tok.length; k += 2) {
        if (k === verbAt) {
          if (ADVERBS.has(tok[k].toLowerCase()) && /^\s+$/.test(tok[k + 1] ?? "")) verbAt = k + 2;
          else tok[k] = forThey(tok[k]);
          continue;
        }
        const m = tok[k].match(/^(he|him|his|himself)(['’](?:s|ll|d))?$/i);
        if (!m) continue;
        const w = m[1].toLowerCase();
        const clitic = m[2] ?? "";
        if (w === "he" && !named) {
          named = true;
          tok[k] = `${name}${clitic}`;
          continue;
        }
        const out = m[1][0] === m[1][0].toUpperCase() ? `${SWAP[w][0].toUpperCase()}${SWAP[w].slice(1)}` : SWAP[w];
        // "he's" → "they're"; "he'll", "he'd" keep theirs.
        tok[k] = `${out}${w === "he" && /s$/i.test(clitic) ? clitic.replace(/s$/i, "re") : clitic}`;
        if (w === "he" && !clitic && /^\s+$/.test(tok[k + 1] ?? "")) verbAt = k + 2;
      }
      return tok.join("");
    })
    .join("");
}

/**
 * Why a question's slide may not ship, from the slide's own text (the quote is lifted from it), or
 * null. Poll results, participant lists and chat show who was in the room; a slide that uses
 * people's names as its data ("Emma" gets inserted…) names them; a poll slide that letters the
 * same option differently from the question contradicts it.
 */
export function slideProblem(q: Pick<PracticeQuestion, "quote" | "choices">, names: string[]): string | null {
  const text = q.quote;
  if (/\b(?:poll results?|responses?|votes?|voted|participants?|attendees?|attendance|chat)\b/i.test(text)) return "poll results or participants on the slide";
  if (/["“][\p{Lu}][\p{Ll}]+["”]/u.test(text) || redact(text, names) !== text) return "names on the slide";
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const m of text.matchAll(/(?:^|[\s●•○▪■])([A-H])[.)]\s+([^●•○▪■\n]+?)(?=\s+[●•○▪■]|\s+[A-H][.)]\s|$)/g)) {
    const other = q.choices.find((c) => norm(c.text) === norm(m[2]));
    if (other && other.label !== m[1]) return "the slide letters its options differently";
  }
  return null;
}

/**
 * A poll or answer slide: it shows the question's answer, so it may not be shown before the student
 * answers. "Poll" in the slide's title (its first words) or in the quote taken from it.
 */
export function answerSlide(slideText: string | null, quote: string): boolean {
  return /\bpoll\b/i.test((slideText ?? "").slice(0, 40)) || /\bpoll\b/i.test(quote);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function exportDemoBundle(output: PipelineOutput, transcripts: PipelineTranscript[], opts: ExportOptions): ExportResult {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  const byUrl = new Map(transcripts.filter((t) => t.recordingUrl).map((t) => [t.recordingUrl, t]));
  const lecturerOf = new Map(transcripts.map((t) => [t.id, dominantSpeaker(t.segments)]));
  const names = [...new Set([...otherSpeakerNames(transcripts, new Set([...lecturerOf.values()].filter((x): x is string => !!x))), ...(opts.redactNames ?? [])])].sort();

  const groups = new Map<string, { q: PracticeQuestion; t: PipelineTranscript; image: string }[]>();
  for (const q of output.questions) {
    if (q.examId !== null) {
      skip("exam set");
      continue;
    }
    if (opts.exclude?.[q.id]) {
      skip("excluded by hand");
      continue;
    }
    const problem = slideProblem(q, names);
    if (problem) {
      skip(problem);
      continue;
    }
    const clip = q.retrieval.clip;
    if (!clip) {
      skip("no clip");
      continue;
    }
    const t = byUrl.get(clip.recordingUrl);
    const day = dayOf(t?.recordedAt);
    // Its own lecture: the clip's transcript is loaded and is the one the retriever named.
    if (!t || !day || (clip.transcriptId && clip.transcriptId !== t.id)) {
      skip("clip not in its own lecture");
      continue;
    }
    // A demo question always shows a slide (the bundle has no slide-less question).
    if (!shownSlide(q)) {
      skip("no slide");
      continue;
    }
    const image = opts.slideImage(q);
    if (!image) {
      skip("no slide image");
      continue;
    }
    const lecturer = lecturerOf.get(t.id) ?? null;
    if (!t.segments.some((s) => (!lecturer || s.speaker === lecturer) && s.start >= clip.start && s.start < clip.end)) {
      skip("no lecturer lines in the clip");
      continue;
    }
    groups.set(day, [...(groups.get(day) ?? []), { q, t, image }]);
  }

  const ids = { ...opts.ids };
  const taken = new Set(Object.values(ids));
  if (taken.size !== Object.keys(ids).length) throw new Error("The demo id map gives two questions the same id");
  const slides: ExportResult["slides"] = [];
  const fine: { id: string; lecture: string; topic: string }[] = [];
  const untitled: string[] = [];
  const noTopic: string[] = [];
  const sets: DemoSetFile[] = [...groups.keys()].sort().map((day) => {
    const prefix = `l${day.replaceAll("-", "")}`;
    // In lecture order (ties by pipeline id, so the order is stable); a new question gets its lecture's next free number.
    const list = [...groups.get(day)!].sort((a, b) => a.q.retrieval.clip!.start - b.q.retrieval.clip!.start || a.q.id.localeCompare(b.q.id));
    for (const { q } of list) {
      if (ids[q.id]) {
        if (!ids[q.id].startsWith(`${prefix}-q`)) throw new Error(`Question ${q.id} is ${ids[q.id]} in the id map but is in the ${day} lecture`);
        continue;
      }
      let n = 1;
      while (taken.has(`${prefix}-q${n}`)) n++;
      ids[q.id] = `${prefix}-q${n}`;
      taken.add(ids[q.id]);
    }
    // The hosted-clip questions first, in the hosted list's order, then the rest in lecture order.
    const rank = (id: string) => (opts.hosted.includes(id) ? opts.hosted.indexOf(id) : opts.hosted.length);
    list.sort((a, b) => rank(ids[a.q.id]) - rank(ids[b.q.id]));
    const hosted = list.map(({ q }) => ids[q.id]).filter((id) => opts.hosted.includes(id));
    const questions = list.map(({ q, t, image }): DemoQuestionFile => {
      const clip = q.retrieval.clip!;
      const id = ids[q.id];
      const ext = image.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? ".png";
      const to = `slides/${id}${ext}`;
      slides.push({ from: image, to });
      const lecturer = lecturerOf.get(t.id) ?? null;
      // Every string that ships goes through redact().
      const r = (text: string) => redact(text, names);
      const cite = shownSlide(q)!;
      const deck = cite.kind === "slide" ? cite.deck : cite.name;
      const page = cite.page;
      // The quote's own page, when the slide shown is another one.
      const qs = q.quoteSource;
      const quoteAt = (qs.kind === "slide" || qs.kind === "document") && (qs.itemId !== cite.itemId || qs.page !== page) ? { quoteDeck: r(qs.kind === "slide" ? qs.deck : qs.name), quotePage: qs.page } : {};
      const kind = opts.pageKinds?.[image] ?? (cite.kind === "document" ? "page" : "slide");
      const text = opts.slideText?.(deck, page) ?? null;
      const reveals = opts.revealsAnswer?.includes(id) || answerSlide(text, q.quote);
      const topic = slideTopic(opts.topics, deck, page, text);
      if (!topic) noTopic.push(`${id} (${deck} p${page})`);
      else {
        fine.push({ id, lecture: day, topic: topic.topic });
        if (topic.from === "untitled") untitled.push(id);
      }
      return {
        id,
        topic: "", // after the merges, below
        stem: r(q.stem),
        code: q.code?.lines.length ? { language: q.code.language, lines: q.code.lines.map(r) } : null,
        choices: q.choices.map((c) => ({ label: c.label, text: r(c.text) })),
        answer: q.answer,
        explanation: r(q.explanation),
        quote: r(q.quote),
        slide: { deck: r(deck), page, kind, image: to, ...(reveals ? { revealsAnswer: true as const } : {}), ...quoteAt },
        clip: { start: clip.start, end: clip.end, setup: clip.setup ? r(namedSetup(clip.setup, opts.lecturer.short)) : null },
        lines: t.segments
          .filter((s) => (!lecturer || s.speaker === lecturer) && s.start >= clip.start && s.start < clip.end)
          .map((s) => ({ start: round2(s.start), end: round2(s.end), text: r(s.text) })),
      };
    });
    return {
      id: day,
      title: `Lecture practice, ${short(day)}`,
      lecture: `Lecture, ${short(day)}`,
      hosted,
      questions,
    };
  });

  if (noTopic.length) throw new Error(`No topic for ${noTopic.join(", ")}: the slide has no title the topics table knows, and it isn't in its untitled list`);
  const merged = mergeTopics(opts.topics, fine);
  for (const s of sets) for (const q of s.questions) q.topic = merged.get(q.id)!;

  return {
    bundle: {
      format: BUNDLE_FORMAT,
      label: PERMISSION_LABEL,
      course: { code: output.course.code, name: output.course.name },
      lecturer: opts.lecturer,
      sets,
    },
    slides,
    skipped: Object.fromEntries(Object.entries(skipped).sort((a, b) => a[0].localeCompare(b[0]))),
    ids: Object.fromEntries(Object.entries(ids).sort((a, b) => a[1].localeCompare(b[1], "en", { numeric: true }))),
    untitled: untitled.sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
  };
}
