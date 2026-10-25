// A fake Quick build model for tests and the e2e dev server (REWIND_FAKE_LLM=1, development only): no network, no key,
// no spend. It reads the prompt it is given, quotes the first words of the first passage word for word, and asks about
// them, so the real checks (rules, word-for-word quote, the blind answer check) have something real to run on.

import type { QuickModel } from "./service.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The first passage's words, without the [mm:ss] labels of lecture lines. */
function firstWords(prompt: string): string[] {
  const block = prompt.match(/<course-material>\n\[P1\][^\n]*\n([\s\S]*?)(?:\n\n\[P2\]|\n<\/course-material>)/)?.[1] ?? "";
  return block.replace(/^\[\d+:\d{2}(?::\d{2})?\] /gm, "").split(/\s+/).filter(Boolean);
}

export function fakeQuickModel(opts: { delayMs?: number } = {}): QuickModel {
  return async (prompt) => {
    await wait(opts.delayMs ?? 150);
    const usage = { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 120 };
    if (/^You check practice questions/.test(prompt)) {
      return {
        reply: { answer: "B", why: "The passage says so.", unambiguous: true, uniqueUnderDefinition: true, standsAlone: true, optionsParallel: true, soundsLikeCourse: true, quoteSupports: true, problems: "" },
        ...usage,
      };
    }
    const w = firstWords(prompt);
    const quote = w.slice(0, 12).join(" ");
    return {
      reply: {
        stem: `Which words come right before "${w.slice(4, 7).join(" ")}" in the text?`,
        code: { language: "", lines: [], passage: "" },
        choices: { A: "Nothing at all", B: w.slice(0, 4).join(" ").slice(0, 40), C: "The last item stored", D: "Only the first key" },
        answer: "B",
        explanation: "The text begins with them.",
        quote,
        quotePassage: "P1",
      },
      ...usage,
    };
  };
}
