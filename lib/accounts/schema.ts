// What an account stores: the student's own answers and nothing from the course. A record is an id,
// the question's id, the course code, the choice, whether it was right, the confidence and when.
// Never the stem, the topic, a quote or any transcript text: the browser re-derives those from
// `questionId` and the bundle it already has. Example history is never uploaded.
//
// The server checks every body against this schema: only these keys, ids in the app's own shapes (no
// spaces, at most a few short words, so no sentence fits), a strict UTC time, at most MAX_ATTEMPTS
// records and MAX_BYTES per body.

import type { AttemptRecord } from "../attempts/store.ts";
import type { ChoiceLabel, Confidence } from "../schema.ts";
import { StorageUnavailable } from "./kv.ts";

export interface AccountAttempt {
  id: string;
  questionId: string;
  course: string;
  choice: ChoiceLabel;
  correct: boolean;
  confidence: Confidence | null;
  /** ISO date-time. */
  answeredAt: string;
}

export const MAX_ATTEMPTS = 2000;
export const MAX_BYTES = 256 * 1024;

const KEYS = ["id", "questionId", "course", "choice", "correct", "confidence", "answeredAt"] as const;
/** An attempt's id (lib/attempts/store.ts newId: "att-" and 32 hex or base-36 characters). */
const ATTEMPT_ID = /^att-[a-z0-9]{8,36}$/;
/**
 * A question's id as the app makes them: "demo-q1" (demo bundle), "q-k3j9x2ab" (lib/pipeline/generate.ts),
 * "q3" (spike seed), "q-code-clip" (e2e fixture). A short word, then at most three more joined by "-".
 */
const QUESTION_ID = /^[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,16}){0,3}$/;
const MAX_QUESTION_ID = 40;
/** courseKey() output: "COP3530", or a short slug for other codes. */
const COURSE = /^([A-Z]{3}\d{4}[A-Z]?|[a-z0-9]{1,16}(-[a-z0-9]{1,16}){0,2})$/;
const ANSWERED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
const CHOICES = new Set(["A", "B", "C", "D"]);
const CONFIDENCES = new Set(["guessing", "fairly-sure", "certain"]);

/** Strict UTC ISO time that survives a round trip ("2026-02-30T…" and free text fail). */
function isAnsweredAt(x: string): boolean {
  if (!ANSWERED_AT.test(x)) return false;
  const d = new Date(x);
  // toISOString always writes milliseconds: compare with them padded to three digits.
  const padded = x.replace(/(\.\d{1,3})?Z$/, (_, ms: string | undefined) => `${(ms ?? ".").padEnd(4, "0")}Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString() === padded;
}

export type Parsed = { ok: true; attempts: AccountAttempt[] } | { ok: false; error: string };

function attemptError(x: unknown): string | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return "not an object";
  const a = x as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length) return `unexpected keys: ${extra.slice(0, 5).join(", ")}`;
  if (typeof a.id !== "string" || a.id.length > 40 || !ATTEMPT_ID.test(a.id)) return "bad id";
  if (typeof a.questionId !== "string" || a.questionId.length > MAX_QUESTION_ID || !QUESTION_ID.test(a.questionId)) return "bad questionId";
  if (typeof a.course !== "string" || !COURSE.test(a.course)) return "bad course";
  if (typeof a.choice !== "string" || !CHOICES.has(a.choice)) return "bad choice";
  if (typeof a.correct !== "boolean") return "bad correct";
  if (a.confidence !== null && (typeof a.confidence !== "string" || !CONFIDENCES.has(a.confidence))) return "bad confidence";
  if (typeof a.answeredAt !== "string" || !isAnsweredAt(a.answeredAt)) return "bad answeredAt";
  return null;
}

/** Checks a request body (its raw text): `{ "attempts": [...] }` and nothing else. Errors name the problem, never the content. */
export function parseAttemptsBody(raw: string): Parsed {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) return { ok: false, error: "body too large" };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "not an object" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "attempts") return { ok: false, error: "body must be { attempts }" };
  const list = (body as { attempts: unknown }).attempts;
  if (!Array.isArray(list)) return { ok: false, error: "attempts must be a list" };
  if (list.length > MAX_ATTEMPTS) return { ok: false, error: "too many attempts" };
  for (let i = 0; i < list.length; i++) {
    const err = attemptError(list[i]);
    if (err) return { ok: false, error: `attempt ${i}: ${err}` };
  }
  return { ok: true, attempts: list as AccountAttempt[] };
}

/** Only the allowed fields, in a fixed order (for stored data read back). */
function pick(a: AccountAttempt): AccountAttempt {
  return { id: a.id, questionId: a.questionId, course: a.course, choice: a.choice, correct: a.correct, confidence: a.confidence, answeredAt: a.answeredAt };
}

/** What leaves the device for one attempt: `stem`, `topic` and `example` are stripped. Examples give null. */
export function toAccountAttempt(record: AttemptRecord, course: string): AccountAttempt | null {
  if (record.example) return null;
  const a: AccountAttempt = { id: record.id, questionId: record.questionId, course, choice: record.choice, correct: record.correct, confidence: record.confidence, answeredAt: record.answeredAt };
  return attemptError(a) ? null : a;
}

/**
 * Records read back from the store. Only the allowed fields are kept. A list that isn't a list, or any record that fails the
 * schema, throws StorageUnavailable: dropping it and carrying on would show the account as emptier than it is, and
 * the next sync would build on that.
 */
export function readStoredAttempts(list: unknown): AccountAttempt[] {
  if (!Array.isArray(list)) throw new StorageUnavailable("stored list is not a list");
  if (list.some((a) => attemptError(a))) throw new StorageUnavailable("a stored record is not what was written");
  return list.map((a) => pick(a as AccountAttempt));
}
