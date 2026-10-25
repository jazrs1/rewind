"use client";

// One tutor conversation: its turns, and sending a turn (a hint, the answer, a typed reply or a similar question) to
// the dev or demo route, streamed in as newline-delimited JSON. The public demo never breaks: when the live tutor is
// capped, errors, is slower than FIRST_TOKEN_MS or is cut off, a reply saved ahead of time is played (labelled). The
// tutor panel and the full-screen study session share it, so ⤢ carries the same conversation over.

import { useCallback, useEffect, useRef, useState } from "react";
import { fallbackCopy, FIRST_TOKEN_MS, GENERIC_SAVED, pickSaved, pickSavedSimilar, SAVED_URL, type SavedFile } from "@/lib/demo/tutor-pick";
import type { ChoiceLabel } from "@/lib/schema";
import type { Grounded } from "@/lib/tutor/claims";
import { SIMILAR_INTRO, similarTurnText, type SimilarCard } from "@/lib/tutor/similar";
import type { TutorConfig, TutorTurn } from "./types";

export type ChatRequest = "hint" | "answer" | "reply" | "similar";

/** The saved replies file, fetched once (public/demo/course/tutor.json); null when it isn't there. */
let savedFile: Promise<SavedFile | null> | null = null;
const loadSaved = async (questionId: string) =>
  ((await (savedFile ??= fetch(SAVED_URL).then((r) => (r.ok ? (r.json() as Promise<SavedFile>) : null)).catch(() => null)))?.questions ?? {})[questionId];

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

const FAILED = "The tutor couldn't answer just now. Try again.";

/** Where the conversation is kept for ⤢ (the study session picks it up): this tab only, cleared when read. */
export const CARRY_KEY = "rewind-tutor-carry";

export function useTutorChat({
  config,
  questionId,
  marked,
  initial,
  topic,
}: {
  config: TutorConfig;
  questionId: string;
  marked: ChoiceLabel | null;
  initial?: TutorTurn[];
  /** The study session's topic in focus: every new turn is stamped with it. */
  topic?: string;
}) {
  const [turns, setTurns] = useState<TutorTurn[]>(initial ?? []);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(Math.max(0, ...(initial ?? []).map((t) => t.id)) + 1);
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  const hintsUsed = turns.filter((t) => t.role === "tutor" && t.kind === "hint" && !t.error).length;

  /** A note the page adds itself (the study session's topic line): a tutor turn that is never sent back as the tutor's. */
  const note = useCallback((text: string, extra: Partial<TutorTurn> = {}, said?: string) => {
    setTurns((all) => [
      ...all,
      // What the student tapped ("Quiz me"), as their own words; a page action, never sent to the tutor as history.
      ...(said ? [{ id: nextId.current++, role: "student" as const, text: said, pill: true, note: true, qid: extra.qid }] : []),
      { id: nextId.current++, role: "tutor", text, kind: "reply", note: true, ...extra },
    ]);
  }, []);

  const send = useCallback(
    async (request: ChatRequest, message: string, pill?: string) => {
      if (busy) return;
      // Only this question's turns: a tutor turn is signed for the question it answered (lib/tutor/sign.ts), so the study
      // session, which moves between questions, sends each topic its own thread.
      const finished = turnsRef.current.filter((t) => !t.streaming && !t.error && !t.note && t.text && (t.qid ?? questionId) === questionId);
      const history = finished.map((t) => ({ role: t.role, text: t.role === "student" && t.pill ? `(asked for: ${t.text})` : (t.said ?? t.text), kind: t.kind, sig: t.sig }));
      const hintsSoFar = finished.filter((t) => t.role === "tutor" && t.kind === "hint").length;
      const repliesSoFar = finished.filter((t) => t.role === "tutor" && t.kind === "reply" && !t.similar).length;
      const similarSoFar = finished.filter((t) => t.similar).length;
      const sid = nextId.current++;
      const tid = nextId.current++;
      setTurns((all) => [...all, { id: sid, role: "student", text: pill ?? message, pill: !!pill, qid: questionId, topic }, { id: tid, role: "tutor", text: "", streaming: true, qid: questionId, topic }]);
      setBusy(true);
      const ac = new AbortController();
      abort.current = ac;
      const patch = (p: Partial<TutorTurn>) => setTurns((all) => all.map((t) => (t.id === tid ? { ...t, ...p } : t)));
      const demo = !!config.demo;
      let slow = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let why: string | null = null;
      const playSaved = async () => {
        const entry = await loadSaved(questionId);
        if (request === "similar") {
          const card = pickSavedSimilar(entry, similarSoFar);
          if (card) patch({ streaming: false, text: SIMILAR_INTRO, kind: "reply", similar: card, said: similarTurnText(card), saved: true });
          else patch({ streaming: false, text: fallbackCopy(why, "similar"), kind: "reply", saved: true });
          return;
        }
        const picked = pickSaved(entry, { request, hintsUsed: hintsSoFar, repliesUsed: repliesSoFar, marked: marked !== null });
        if ("refuse" in picked) patch({ streaming: false, text: picked.refuse, kind: "reply", saved: true });
        else if (picked.reply === GENERIC_SAVED) patch({ streaming: false, text: fallbackCopy(why, request), kind: picked.kind, saved: true });
        else patch({ streaming: false, text: picked.reply.text, kind: picked.kind, grounded: picked.reply.grounded, saved: true });
      };
      try {
        if (demo) {
          timer = setTimeout(() => {
            slow = true;
            ac.abort();
          }, FIRST_TOKEN_MS);
        }
        // The demo sends only the question, what the student wrote and the signed turns; the dev tutor also names its set and visit.
        const payload = demo
          ? { questionId, message, request, marked, history }
          : { set: config.set, questionId, session: config.session, request, message, history, marked };
        const res = await fetch(config.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ac.signal, body: JSON.stringify(payload) });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        let text = "";
        let fallback = false;
        let sawDone = false;
        for await (const ev of lines(res)) {
          if (ev.t === "text") {
            clearTimeout(timer);
            text += String(ev.d);
            patch({ text });
          } else if (ev.t === "done") {
            clearTimeout(timer);
            sawDone = true;
            const similar = (ev.similar as SimilarCard | null | undefined) ?? undefined;
            patch({
              streaming: false,
              sig: String(ev.sig),
              kind: ev.mode === "hint" ? "hint" : ev.mode === "answer" ? "answer" : "reply",
              grounded: (ev.grounded as Grounded[]) ?? [],
              ...(similar ? { similar } : {}),
              ...(typeof ev.history === "string" ? { said: ev.history } : {}),
            });
          } else if (ev.t === "fallback") {
            fallback = true;
            why = typeof ev.why === "string" ? ev.why : null;
            break;
          } else if (ev.t === "error") {
            sawDone = true;
            if (demo) fallback = true;
            else patch({ streaming: false, error: true, text: String(ev.m) });
          }
        }
        // A stream that ended after some words with no "done" was cut off: the demo plays the saved reply instead of a half answer.
        if (!sawDone && !fallback) {
          if (demo) fallback = true;
          else patch({ streaming: false, error: true, text: FAILED });
        }
        if (fallback) await playSaved();
      } catch (e) {
        if (demo && (slow || (e as Error).name !== "AbortError")) await playSaved();
        else if ((e as Error).name !== "AbortError") patch({ streaming: false, error: true, text: FAILED });
      } finally {
        clearTimeout(timer);
        setBusy(false);
        setTurns((all) => all.map((t) => (t.id === tid && t.streaming ? { ...t, streaming: false } : t)));
      }
    },
    [busy, config.demo, config.endpoint, config.set, config.session, questionId, marked, topic],
  );

  /**
   * The study session's greeting after a topic switch: one per switch. A greeting nobody answered gives way to the new
   * one (with its divider); after a conversation, a thin divider naming the topic goes first.
   */
  const greet = useCallback((text: string, extra: Partial<TutorTurn>, divider: string) => {
    setTurns((all) => {
      let list = all;
      if (list.at(-1)?.greeting) {
        list = list.slice(0, -1);
        if (list.at(-1)?.divider) list = list.slice(0, -1);
      }
      const rule: TutorTurn[] = list.length ? [{ id: nextId.current++, role: "tutor", text: "", note: true, divider, topic: extra.topic }] : [];
      return [...list, ...rule, { id: nextId.current++, role: "tutor", text, kind: "reply", note: true, greeting: true, ...extra }];
    });
  }, []);

  return { turns, busy, hintsUsed, send, note, greet };
}
