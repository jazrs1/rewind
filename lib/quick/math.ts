// Quick build (beta): course text's LaTeX ("$...$" inline, "$$...$$" display: Canvas equation images arrive as
// "$...$", lib/quick/export.ts) rendered with KaTeX for the stems, choices and quote cards. Never trusted:
// trust: false (no \href, \url, \includegraphics, \htmlClass...), a small maxExpand, throwOnError: false; KaTeX escapes
// everything it outputs. If KaTeX can't render a piece, that piece stays its raw text. The quote check (quoteIn)
// still compares the raw text: this is display only.

import katex from "katex";

export type MathPart = { kind: "text"; text: string } | { kind: "math"; tex: string; display: boolean; raw: string };

/**
 * Text and math, in order. "$$...$$" is display math. "$...$" is inline math by Pandoc's rule, so prices stay text:
 * the opening $ is followed by a non-space, the closing $ follows a non-space and isn't followed by a digit.
 * "\$" is a dollar sign, not math.
 */
export function mathParts(text: string): MathPart[] {
  const out: MathPart[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "$") {
      buf += "\\$";
      i += 2;
      continue;
    }
    if (text.startsWith("$$", i)) {
      const end = text.indexOf("$$", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "math", tex: text.slice(i + 2, end).trim(), display: true, raw: text.slice(i, end + 2) });
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "$" && text[i + 1] !== undefined && !/\s/.test(text[i + 1])) {
      let j = i + 1;
      let end = -1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "$") {
          if (!/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? "")) end = j;
          break;
        }
        j++;
      }
      if (end > i + 1) {
        flush();
        out.push({ kind: "math", tex: text.slice(i + 1, end), display: false, raw: text.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

/** KaTeX's colour for what it couldn't parse or wouldn't run (an unknown or untrusted command): a sentinel to look for. */
const ERROR_COLOR = "#cc0001";

/** KaTeX's HTML for one piece of math, or null when it can't be rendered (the caller shows the raw text). */
export function renderMath(tex: string, display: boolean): string | null {
  try {
    const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, errorColor: ERROR_COLOR, trust: false, maxExpand: 100, strict: "ignore", output: "htmlAndMathml" });
    // throwOnError: false marks what it couldn't parse as an error span, and an unknown or untrusted command (\href with
    // trust: false) in the error colour: either way, show the raw text instead.
    return /class="katex-error"/.test(html) || html.includes(ERROR_COLOR) ? null : html;
  } catch {
    return null;
  }
}

/** Does this text hold any math worth rendering? (Lets callers skip the work for plain text.) */
export function hasMath(text: string): boolean {
  return text.includes("$") && mathParts(text).some((p) => p.kind === "math");
}
