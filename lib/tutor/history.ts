// The conversation history the browser sends back. It is data, not a record the server can trust: student
// turns are taken as written (and fenced and escaped in the prompt), and a turn that claims to be the tutor's
// counts as one only if its signature is valid for this question (lib/tutor/sign.ts); otherwise it is student text.

import type { TutorTurnIn } from "./service.ts";
import { replyOk as processReplyOk } from "./sign.ts";

export const MAX_TURNS = 14;
export const MAX_TURN_CHARS = 1500;

export function cleanHistory(raw: unknown, questionId: string, replyOk: (q: string, kind: string, text: string, sig: unknown) => boolean = processReplyOk): TutorTurnIn[] {
  const list = Array.isArray(raw) ? (raw as (TutorTurnIn & { sig?: unknown })[]) : [];
  return list
    .slice(-MAX_TURNS)
    .filter((t) => t && (t.role === "student" || t.role === "tutor") && typeof t.text === "string")
    .map((t): TutorTurnIn => {
      const text = t.text.slice(0, MAX_TURN_CHARS);
      const kind = t.kind === "hint" || t.kind === "answer" || t.kind === "reply" ? t.kind : "reply";
      if (t.role === "tutor" && replyOk(questionId, kind, text, t.sig)) return { role: "tutor", text, kind };
      return { role: "student", text };
    });
}
