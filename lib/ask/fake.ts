// A fake Ask model for tests and the e2e dev server (REWIND_FAKE_LLM=1, development only, lib/tutor/fake.ts
// fakeLlmOn): no network, no key, no spend. It reads the student's words and the tool results out of the prompt and
// answers the way a careful model would: it asks for the right tool first, then writes a short answer that quotes a
// passage word for word. It never writes a date of its own.

import type { AskReplyJSON } from "../prompts/ask.ts";
import type { ToolCall } from "./types.ts";
import type { AskGenerate } from "./service.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const empty: Omit<ToolCall, "tool"> = { course: "", courses: [], query: "", from: "", to: "", kinds: [], topics: [], n: 0, exam: "" };
const call = (tool: ToolCall["tool"], o: Partial<ToolCall> = {}): ToolCall => ({ ...empty, ...o, tool });
const answer = (text: string, claims: AskReplyJSON["claims"] = []): AskReplyJSON => ({ tool_calls: [], text, claims });
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/ ⏎ /g, "\n");

const OFF_TOPIC = /weather|joke|poem|recipe|movie|football|stock|bitcoin|ignore (?:all|your|the) (?:previous|rules|instructions)/i;

/** "the next 2 weeks" → +14d, "this week" → end_of_week, "next 10 days" → +10d. */
function rangeOf(said: string): { from: string; to: string } {
  const n = said.match(/next\s+(\d+|two|three|four)\s+(day|week)s?/i);
  if (n) {
    const k = { two: 2, three: 3, four: 4 }[n[1].toLowerCase() as "two"] ?? Number(n[1]);
    return { from: "today", to: `+${k}${n[2].toLowerCase()[0]}` };
  }
  if (/this week/i.test(said)) return { from: "today", to: "end_of_week" };
  if (/next week/i.test(said)) return { from: "start_of_next_week", to: "end_of_next_week" };
  if (/this month/i.test(said)) return { from: "today", to: "end_of_month" };
  return { from: "today", to: "+14d" };
}

/** The course names after "for" / "in": "practice for DSA and MAS" → ["DSA", "MAS"]. */
function namesOf(said: string): string[] {
  const m = said.match(/\b(?:for|in|on)\s+(.+?)(?:[?.!]|$)/i);
  if (!m) return [];
  return m[1]
    .split(/\s*(?:,|\band\b|&|\+)\s*/i)
    .map((s) => s.replace(/\b(?:the|my|exam|exams|class|course|midterm)\b/gi, "").trim())
    .filter((s) => s && s.length <= 40);
}

export function fakeAsk(opts: { delayMs?: number } = {}): AskGenerate {
  return async (prompt): Promise<AskReplyJSON> => {
    await wait(opts.delayMs ?? 300);
    const said = unescape(prompt.match(/<student>([\s\S]*?)<\/student>/)?.[1] ?? "");
    const results = [...prompt.matchAll(/^Result (\d+)\.(\d+) \((\w+)\): (.*)$/gm)].map((m) => ({ tool: m[3], data: JSON.parse(unescape(m[4])) as Record<string, unknown> }));
    const graded = /This is graded work:/.test(prompt);
    if (OFF_TOPIC.test(said)) return answer("I can only help with your courses and studying here. Want to see what's coming up, or practice something?");
    if (!results.length) {
      if (/\b(?:exams?|due|deadlines?|quiz(?:zes)?|assignments?|coming up|tests?)\b/i.test(said) && !/practi[cs]e|what did|explain/i.test(said)) return { tool_calls: [call("list_deadlines", { ...rangeOf(said), kinds: ["exam", "quiz", "assignment"] })], text: "", claims: [] };
      if (/practi[cs]e|quiz me|questions/i.test(said) && !graded) {
        // "practice for DSA and MAS" names courses; "practice graphs and hash tables" names topics.
        const topics = /\bfor\b/i.test(said) ? [] : (said.match(/practi[cs]e\s+(.+?)[?.!]*$/i)?.[1].split(/\s*(?:,|\band\b|&)\s*/i).filter(Boolean) ?? []);
        return { tool_calls: [call("get_questions", { courses: namesOf(said), topics, n: 6 })], text: "", claims: [] };
      }
      const about = said.match(/(?:say|said|talk|talked)\s+about\s+(.+?)[?.!]*$/i);
      if (about) {
        const who = said.match(/what did\s+(?:professor\s+|prof\.?\s+|dr\.?\s+)?(\w+)/i)?.[1] ?? "";
        return { tool_calls: [call("search_course", { course: who, query: about[1] })], text: "", claims: [] };
      }
      const topic = said.match(/explain\s+(.+?)(?:,|\.|\?|!|\s+i'?m\b|$)/i)?.[1];
      if (topic || /behind|teach|understand/i.test(said)) return { tool_calls: [call("search_course", { query: (topic ?? said).replace(/\b(?:this|topic|again)\b/gi, "").trim() || said })], text: "", claims: [] };
      return { tool_calls: [call("list_courses")], text: "", claims: [] };
    }
    const last = results[results.length - 1];
    if (last.tool === "list_deadlines") {
      const items = (last.data.items as { title: string; graded: boolean }[] | undefined) ?? [];
      const noDate = (last.data.no_date as string[] | undefined) ?? [];
      const nothing = (last.data.nothing_found as string[] | undefined) ?? [];
      if (!items.length) return answer([...nothing, ...noDate].join(" ") || "Nothing dated in that range in your Canvas data.");
      return answer(String(last.data.summary ?? `${items.length} items in that range.`));
    }
    if (last.tool === "get_questions") {
      const qs = (last.data.questions as { course: string }[] | undefined) ?? [];
      const none = (last.data.no_question_bank as string[] | undefined) ?? [];
      const codes = [...new Set(qs.map((q) => q.course))];
      const lead = qs.length ? `Here are ${qs.length} questions from ${codes.join(" and ")}, the topics you miss most first. Mark each card.` : "I couldn't find practice questions for that.";
      if (graded) return answer("This is graded work, so I'll guide you instead of giving practice answers. Where are you stuck?");
      return answer(`${lead}${none.length ? ` ${none.join(" ")} I can search its material or list its deadlines instead.` : ""}`);
    }
    if (last.tool === "search_course") {
      const ps = (last.data.passages as { id: string; text: string; where: string }[] | undefined) ?? [];
      if (!ps.length) return answer(`I didn't find that in your course material. ${String(last.data.nothing_found ?? "")}`.trim());
      // Quotes the passage's sentence that says most of what the student asked about, word for word.
      const asked = new Set(said.toLowerCase().match(/[a-z]{4,}/g) ?? []);
      const sentence = (t: string) => {
        const all = (t.match(/[^.?!]{25,}[.?!]/g) ?? [t.slice(0, 120)]).map((x) => x.trim());
        const score = (x: string) => (x.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => asked.has(w)).length;
        return all.reduce((best, x) => (score(x) > score(best) ? x : best), all[0]);
      };
      const q1 = sentence(ps[0].text);
      const claims = [{ quote: q1, source: ps[0].id }];
      if (ps[1]) claims.push({ quote: sentence(ps[1].text), source: ps[1].id });
      return answer(`${graded ? "On graded work I'll guide you rather than solve it. " : ""}From ${ps[0].where}: "${q1}" Want a practice question on it?`, claims);
    }
    if (last.tool === "open_study") return answer(String(last.data.opened ? `Here's the study session for ${last.data.opened}.` : last.data.error));
    const courses = (last.data.courses as { code: string; title: string }[] | undefined) ?? [];
    return answer(`You have ${courses.map((c) => `${c.code} (${c.title})`).join(", ")} on this device. Ask what's coming up, or to practice one.`);
  };
}
