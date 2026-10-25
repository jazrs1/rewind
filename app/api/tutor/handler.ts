// The dev tutor's handler, shared by POST /api/tutor (beside a question: the question's topic rule) and POST
// /api/tutor/study (the full-screen study session: the exam's topics, looked up here from the course data). The route
// decides the scope; nothing in the request can.
//
// One tutor turn, streamed. The question, its answer and the course text are looked up here
// from the practice set (dev only, local course data); the request carries only the student's own words, the
// conversation so far, ids and two things the server signed when it rendered the page:
//   - `session`: the page visit (hints are counted per visit and question).
// Whether a question is graded work is decided here, from the course data (lib/tutor/graded.ts: the open
// assignment's modules; unknown = graded), never from anything the browser sends. No valid session = graded.
//   - a `sig` on each tutor turn in the history: a "tutor" turn without a valid one is treated as student text.
// The model reply is checked (integrity, quote-checking: lib/tutor/service.ts) before any of it is sent, then
// streamed as newline-delimited JSON:
//   {"t":"text","d":"..."}  repeated, then  {"t":"done", ..., "sig":"..."}  or  {"t":"error","m":"..."}.
// request "similar" is its own call (lib/tutor/similar.ts): a new question checked for new values and a word-for-word
// source, sent in the done event as `similar`; refused on graded work before any model call.

import { isDemoMode } from "@/lib/demo/guard";
import { generateJSON, LLM_MODELS } from "@/lib/llm";
import { loadPracticeSeed } from "@/lib/pipeline/practice-seed";
import type { SimilarJSON, TutorReplyJSON, TutorRequest } from "@/lib/prompts/tutor";
import type { ChoiceLabel } from "@/lib/schema";
import { gradedScope } from "@/lib/tutor/graded";
import { fakeLlmOn, fakeSimilar, fakeTutor } from "@/lib/tutor/fake";
import { cleanHistory } from "@/lib/tutor/history";
import { allowCall, hintsGivenOn, noteHint } from "@/lib/tutor/limit";
import { tutorReply, type Generate, type TutorTurnIn } from "@/lib/tutor/service";
import { similarQuestion, similarTurnText, type GenerateSimilar } from "@/lib/tutor/similar";
import { studyScope } from "@/lib/study/config";
import type { TutorScope } from "@/lib/prompts/tutor";
import { readSession, replySig } from "@/lib/tutor/sign";

const MAX_MESSAGE = 600;

interface Body {
  set?: string;
  questionId?: string;
  session?: string;
  request?: TutorRequest | "similar";
  message?: string;
  history?: (TutorTurnIn & { sig?: string })[];
  marked?: ChoiceLabel | null;
}

const line = (o: object) => new TextEncoder().encode(JSON.stringify(o) + "\n");

export async function handleDevTutor(req: Request, { study = false }: { study?: boolean } = {}): Promise<Response> {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return new Response("Not found", { status: 404 });
  if (!allowCall()) return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
  let body: Body;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Response("Bad request", { status: 400 });
    body = parsed as Body;
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const seed = await loadPracticeSeed(body.set);
  const question = seed?.questions.find((q) => q.id === body.questionId);
  if (!seed || !question) return new Response("Not found", { status: 404 });
  const similar = body.request === "similar";
  const request: TutorRequest = body.request === "hint" || body.request === "answer" ? body.request : "reply";
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  if (request === "reply" && !message && !similar) return new Response("Bad request", { status: 400 });
  const marked = body.marked && /^[A-D]$/.test(body.marked) ? body.marked : null;
  const history = cleanHistory(body.history, question.id);
  // The study session keeps to the exam's coverage topics; beside a question, to the question (the default).
  let topicScope: TutorScope | undefined;
  if (study) {
    const s = await studyScope(typeof body.set === "string" ? body.set : undefined);
    if (!s) return new Response("Not found", { status: 404 });
    topicScope = s;
  }

  // Graded when the question is in the open assignment's scope (server-side), or the visit can't be vouched for.
  const session = readSession(body.session);
  const scope = await gradedScope(seed, typeof body.set === "string" ? body.set : undefined);
  const graded = !session || scope.isGraded(question.id);
  const assignment = graded ? scope.assignment : null;
  const generate: Generate = fakeLlmOn()
    ? fakeTutor(question)
    : (prompt, schema) => generateJSON<TutorReplyJSON>(LLM_MODELS.tutor, prompt, schema, { maxTokens: 700, effort: "low" });

  const words = async (controller: ReadableStreamDefaultController<Uint8Array>, text: string) => {
    for (const d of text.match(/\S+\s*/g) ?? []) {
      controller.enqueue(line({ t: "text", d }));
      await new Promise((res) => setTimeout(res, fakeLlmOn() ? 45 : 18));
    }
  };
  const fail = (e: unknown) =>
    // Nothing from the course or the key is put in the message.
    line({ t: "error", m: e instanceof Error && e.name === "SpendCapError" ? "The tutor is paused: the model budget is used up." : "The tutor couldn't answer just now. Try again." });

  if (similar) {
    const generateSimilar: GenerateSimilar = fakeLlmOn()
      ? fakeSimilar(question)
      : (prompt, schema) => generateJSON<SimilarJSON>(LLM_MODELS.tutor, prompt, schema, { maxTokens: 900, effort: "low" });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const r = await similarQuestion({ seed, question, graded, marked, scope: topicScope }, generateSimilar);
          await words(controller, r.text);
          // The history carries the question itself, so a later turn can talk about it; the signature covers those words.
          const said = r.card ? similarTurnText(r.card) : r.text;
          controller.enqueue(line({ t: "done", mode: "socratic", grounded: [], rewritten: r.refused, confirmed: false, similar: r.card, history: said, sig: replySig(question.id, "reply", said) }));
        } catch (e) {
          controller.enqueue(fail(e));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const r = await tutorReply(
          {
            seed,
            question,
            graded,
            assignment: assignment ? `${assignment.name}${assignment.topics ? ` (${assignment.topics})` : ""}` : undefined,
            request,
            message,
            history,
            marked,
            hintFloor: session ? hintsGivenOn(session.nonce, question.id) : 0,
            scope: topicScope,
          },
          generate,
        );
        if (session && r.mode === "hint") noteHint(session.nonce, question.id);
        // The reply was checked whole; now it reaches the page word by word.
        await words(controller, r.text);
        const kind = r.mode === "hint" ? "hint" : r.mode === "answer" ? "answer" : "reply";
        controller.enqueue(line({ t: "done", mode: r.mode, grounded: r.grounded, rewritten: r.rewritten, confirmed: r.confirmed, hintsUsed: r.hintsUsed, sig: replySig(question.id, kind, r.text) }));
      } catch (e) {
        controller.enqueue(fail(e));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
