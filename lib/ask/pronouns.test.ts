// John's copy rule for the Ask tab: no he/him/his for professors in its UI strings, prompts or saved replies ("your
// professor", "they", or the name). Word-for-word quotes (claims) are the course's own words and are left as said.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askPrompt, TOOLS_TEXT, SCOPE_RULE } from "../prompts/ask";
import { SAVED_GUIDE, SAVED_OTHER } from "./saved";

const HE = /\b(he|him|his|himself)\b/i;
const RULE = '"he", "him" or "his"';
const root = process.cwd();

/** The code without its comments: what can reach the page or the model (strings, JSX text). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("no he/him/his for professors on the Ask tab", () => {
  it("in its components, tools, prompt and demo route (comments aside)", () => {
    const files = [
      ...readdirSync(join(root, "components/ask")).map((f) => `components/ask/${f}`),
      ...readdirSync(join(root, "lib/ask")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `lib/ask/${f}`),
      "lib/prompts/ask.ts",
      "lib/demo/ask-route.ts",
      "app/ask/page.tsx",
      "app/demo/ask/page.tsx",
      "app/api/ask/route.ts",
      "app/api/demo/ask/route.ts",
    ];
    for (const f of files)
      code(readFileSync(join(root, f), "utf8"))
        .split("\n")
        // The prompt's own rule names the words it forbids.
        .forEach((line, i) => expect(line.replace(RULE, ""), `${f}:${i + 1}`).not.toMatch(HE));
  });
  it("in the prompt the model gets, and the fixed replies", () => {
    const prompt = askPrompt({ message: "What did Kapoor say about load factor?", history: [], rounds: [], guide: { title: "Quiz 4", code: "COP3530" } });
    expect(prompt).toContain(`never ${RULE}`);
    expect(prompt.replace(RULE, "")).not.toMatch(HE);
    for (const t of [TOOLS_TEXT, SCOPE_RULE, SAVED_GUIDE, SAVED_OTHER]) expect(t).not.toMatch(HE);
  });
  it("in the demo's saved replies (their quotes are left word for word)", () => {
    const file = JSON.parse(readFileSync(join(root, "public/demo/course/ask.json"), "utf8")) as { examples: { prompt: string; text: string }[] };
    expect(file.examples.length).toBeGreaterThan(0);
    for (const e of file.examples) {
      expect(e.prompt).not.toMatch(HE);
      expect(e.text, e.prompt).not.toMatch(HE);
    }
  });
});
