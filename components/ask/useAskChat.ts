"use client";

// One Ask conversation: a turn is a tool loop. The page posts the student's words (and the conversation so far) to
// the route; when the model asks for tools, they run here over the courses on this device (lib/ask/tools.ts) and only
// their results go back, for at most MAX_TOOL_ROUNDS rounds; then the answer streams in. The cards come from the tool
// results, the chips from the server-checked claims found again here. Graded work (lib/ask/guide.ts, from the Canvas
// data) is guide mode: the banner, the prompt's graded rule, and no practice set. The public demo never breaks: a
// cap, an error or a slow reply plays the example's saved reply (labelled), its tools run here like a live turn's.

import { useCallback, useEffect, useRef, useState } from "react";
import { chipsFor, type AskChip } from "@/lib/ask/ground";
import { gradedMention, type GuideItem } from "@/lib/ask/guide";
import { savedFor, SAVED_GUIDE, SAVED_OTHER, type SavedAsk } from "@/lib/ask/saved";
import type { SearchHit } from "@/lib/ask/search";
import { runTool, type StudyLink, type ToolDisplay } from "@/lib/ask/tools";
import type { DeadlineResult } from "@/lib/ask/deadlines";
import type { PickedQuestion, QuestionsResult } from "@/lib/ask/questions";
import { MAX_TOOL_ROUNDS, type AskCourse, type ToolCall, type ToolRound } from "@/lib/ask/types";
import { attemptStore } from "@/lib/attempts/store";
import { FIRST_TOKEN_MS } from "@/lib/demo/tutor-pick";
import type { SeedQuestion } from "@/lib/demo/types";

export interface AskTurn {
  id: number;
  role: "student" | "assistant";
  text: string;
  streaming?: boolean;
  /** What the assistant is doing while tools run ("Checking your Canvas dates…"). */
  status?: string;
  error?: boolean;
  saved?: boolean;
  /** The demo route's signature on this reply, sent back with it in the history (an unsigned one counts as student text). */
  sig?: string;
  guide?: GuideItem | null;
  deadlines?: DeadlineResult;
  questions?: PickedQuestion[];
  noBank?: QuestionsResult["noBank"];
  study?: StudyLink[];
  chips?: AskChip[];
  /** A lecture moment opened from a chip, played in place. */
  clip?: AskChip;
}

const STATUS: Record<ToolCall["tool"], string> = {
  list_courses: "Looking at your courses…",
  list_deadlines: "Checking your Canvas dates…",
  search_course: "Searching your lectures and slides…",
  get_questions: "Picking practice questions…",
  open_study: "Finding the study session…",
};

const FAILED = "The assistant couldn't answer just now. Try again.";

async function* lines(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) yield JSON.parse(l) as Record<string, unknown>;
    }
  }
}

class Fallback extends Error {}

export function useAskChat({ courses, endpoint, demo, saved: savedReplies = [] }: { courses: AskCourse[]; endpoint: string; demo: boolean; saved?: SavedAsk[] }) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const nextId = useRef(1);
  const turnsRef = useRef(turns);
  const answeredRef = useRef(answered);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    turnsRef.current = turns;
    answeredRef.current = answered;
  }, [turns, answered]);
  useEffect(() => () => abort.current?.abort(), []);

  const markAnswered = useCallback((id: string) => setAnswered((s) => new Set(s).add(id)), []);

  const openClip = useCallback((chip: AskChip) => {
    setTurns((all) => [...all, { id: nextId.current++, role: "assistant", text: "", clip: chip }]);
  }, []);

  const send = useCallback(
    async (message: string) => {
      const text = message.trim();
      if (!text || busy) return;
      const now = Date.now();
      // Read again over the student's earlier turns, so guide mode carries forward. The demo server decides it again
      // from its own copy of the deadlines; here it draws the banner.
      const earlier = turnsRef.current.filter((t) => t.role === "student").map((t) => t.text).slice(-8);
      const guide = gradedMention(text, courses, now, earlier);
      // Cards still open in the chat: search never hands the model what explains their answers.
      const openIds = () => [...turnsRef.current.flatMap((t) => t.questions ?? []), ...displays.flatMap((d) => (d.kind === "questions" ? d.result.picked : []))].map((p) => p.question.id).filter((id) => !answeredRef.current.has(id));
      const history = turnsRef.current
        .filter((t) => !t.streaming && !t.error && !t.clip && t.text)
        .map((t) => ({ role: t.role, text: t.text, ...(t.sig ? { sig: t.sig } : {}) }))
        .slice(-8);
      const sid = nextId.current++;
      const aid = nextId.current++;
      setTurns((all) => [...all, { id: sid, role: "student", text }, { id: aid, role: "assistant", text: "", streaming: true, guide }]);
      setBusy(true);
      const patch = (p: Partial<AskTurn>) => setTurns((all) => all.map((t) => (t.id === aid ? { ...t, ...p } : t)));
      const ctx = { courses, now, studentText: text, attemptsOf: (id: string) => attemptStore(id).list() };
      const displays: ToolDisplay[] = [];
      const run = (calls: ToolCall[], round: number) =>
        calls.map((c, j) => {
          // Graded work: no practice set and no similar problem.
          if (guide && c.tool === "get_questions") return JSON.stringify({ error: "graded work: no practice questions or similar problems here; guide with questions" });
          const r = runTool(c, { ...ctx, idPrefix: `r${round}c${j + 1}`, openIds: openIds() });
          displays.push(r.display);
          return r.result;
        });
      /** The cards and chips from this turn's tool results (never from the model's words). */
      const finish = (answer: string, claims: { quote: string; source?: string }[], extra: Partial<AskTurn> = {}) => {
        const deadlines = displays.filter((d): d is Extract<ToolDisplay, { kind: "deadlines" }> => d.kind === "deadlines").at(-1)?.result;
        const qs = displays.filter((d): d is Extract<ToolDisplay, { kind: "questions" }> => d.kind === "questions").map((d) => d.result);
        const questions = qs.flatMap((r) => r.picked).filter((p, i, all) => all.findIndex((x) => x.question.id === p.question.id) === i);
        const hits: SearchHit[] = displays.flatMap((d) => (d.kind === "search" ? d.hits : []));
        const study = displays.flatMap((d) => (d.kind === "study" ? [d.link] : []));
        // Chips never give away a card still open in the chat, nor any graded question.
        const open: SeedQuestion[] = [...turnsRef.current.flatMap((t) => t.questions ?? []), ...questions].filter((p) => !answeredRef.current.has(p.question.id)).map((p) => p.question);
        const graded = courses.flatMap((c) => (c.bank ? c.bank.seed.questions.filter((q) => c.bank!.gradedIds.includes(q.id)) : []));
        const chips = chipsFor(claims, hits, courses, { open, graded });
        patch({ streaming: false, status: undefined, text: answer, chips, ...(deadlines ? { deadlines } : {}), ...(questions.length ? { questions } : {}), ...(qs.some((r) => r.noBank.length) ? { noBank: qs.flatMap((r) => r.noBank) } : {}), ...(study.length ? { study } : {}), ...extra });
      };
      const playSaved = () => {
        displays.length = 0;
        if (guide) return finish(SAVED_GUIDE, [], { saved: true });
        const saved = savedFor(text, savedReplies);
        if (!saved) return finish(SAVED_OTHER, [], { saved: true });
        run(saved.calls, 1);
        finish(saved.text, saved.claims, { saved: true });
      };
      const rounds: ToolRound[] = [];
      try {
        for (let round = 0; ; round++) {
          const ac = new AbortController();
          abort.current = ac;
          let slow = false;
          const timer = demo
            ? setTimeout(() => {
                slow = true;
                ac.abort();
              }, FIRST_TOKEN_MS)
            : undefined;
          let res: Response;
          try {
            res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal, body: JSON.stringify({ message: text, history, rounds, guide: guide ? { title: guide.title, code: guide.code } : null, open: openIds() }) });
          } catch (e) {
            clearTimeout(timer);
            if (demo && (slow || (e as Error).name !== "AbortError")) throw new Fallback();
            throw e;
          }
          if (!res.ok || !res.body) {
            clearTimeout(timer);
            if (demo) throw new Fallback();
            throw new Error(String(res.status));
          }
          let answer = "";
          let done = false;
          let calls: ToolCall[] | null = null;
          for await (const ev of lines(res)) {
            clearTimeout(timer);
            if (ev.t === "tools") calls = (ev.calls as ToolCall[]) ?? [];
            else if (ev.t === "text") {
              answer += String(ev.d);
              patch({ text: answer, status: undefined });
            } else if (ev.t === "done") {
              done = true;
              finish(answer, (ev.claims as { quote: string; source: string }[]) ?? [], typeof ev.sig === "string" ? { sig: ev.sig } : {});
            } else if (ev.t === "fallback") throw new Fallback();
            else if (ev.t === "error") {
              if (demo) throw new Fallback();
              patch({ streaming: false, status: undefined, error: true, text: String(ev.m) });
              return;
            }
          }
          clearTimeout(timer);
          if (done) return;
          if (calls && calls.length && round < MAX_TOOL_ROUNDS) {
            patch({ status: STATUS[calls[0].tool] });
            rounds.push({ calls, results: run(calls, round + 1) });
            continue;
          }
          // Cut off with no answer.
          if (demo) throw new Fallback();
          patch({ streaming: false, status: undefined, error: true, text: FAILED });
          return;
        }
      } catch (e) {
        if (e instanceof Fallback) playSaved();
        else if ((e as Error).name !== "AbortError") patch({ streaming: false, status: undefined, error: true, text: FAILED });
      } finally {
        setBusy(false);
        setTurns((all) => all.map((t) => (t.id === aid && t.streaming ? { ...t, streaming: false } : t)));
      }
    },
    [busy, courses, demo, endpoint, savedReplies],
  );

  return { turns, busy, send, openClip, answered, markAnswered };
}
