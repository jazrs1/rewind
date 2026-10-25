// KaTeX for Quick build's course math: synthetic text only (shaped like the coordinator's MAS3114 question).
import { describe, expect, it } from "vitest";
import katex from "katex";
import { quoteIn } from "../pipeline/exams.ts";
import { hasMath, mathParts, renderMath } from "./math.ts";

const QUOTE = String.raw`$\begin{bmatrix} 2a-4b\\3a+2b\\0\\3b \end{bmatrix} = \begin{bmatrix} 2a\\3a\\0\\0 \end{bmatrix} + \begin{bmatrix} -4b\\2b\\0\\3b \end{bmatrix}$`;
const STEM = "Let W be the set of all vectors of the form (2a-4b, 3a+2b, 0, 3b), where a and b are real numbers. Which pair of vectors spans W?";
/** The visible part of KaTeX's output (it also carries MathML, with the TeX as an annotation, for screen readers). */
const visible = (html: string) => html.slice(html.indexOf('class="katex-html"'));

describe("course math with KaTeX", () => {
  it("a bmatrix quote renders as math: a .katex element, no literal \\begin on screen", () => {
    const parts = mathParts(QUOTE);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: "math", display: false });
    const html = renderMath((parts[0] as { tex: string }).tex, false)!;
    expect(html).toContain('class="katex"');
    expect(visible(html)).not.toContain("\\begin");
    expect(visible(html)).not.toContain("bmatrix");
    expect(html).toContain("<math"); // MathML for screen readers
  });

  it("text and math in order; the stem without math stays plain", () => {
    expect(hasMath(STEM)).toBe(false);
    expect(mathParts(`So ${String.raw`$\det(A) = ad - bc$`} here, and $$x^2$$ shown.`)).toEqual([
      { kind: "text", text: "So " },
      { kind: "math", tex: String.raw`\det(A) = ad - bc`, display: false, raw: String.raw`$\det(A) = ad - bc$` },
      { kind: "text", text: " here, and " },
      { kind: "math", tex: "x^2", display: true, raw: "$$x^2$$" },
      { kind: "text", text: " shown." },
    ]);
  });

  it("prices and escaped dollars stay text", () => {
    expect(hasMath("It costs $5 and $10 at the store.")).toBe(false);
    expect(hasMath(String.raw`A \$5 fee, and \$10 more.`)).toBe(false);
    expect(hasMath("Only one $ sign here.")).toBe(false);
  });

  it("malformed LaTeX falls back to the raw text, with no error thrown", () => {
    for (const tex of [String.raw`\frac{1}{`, String.raw`\begin{bmatrix} 1 & 2`, String.raw`\notacommand{x}`]) {
      expect(() => renderMath(tex, false)).not.toThrow();
      expect(renderMath(tex, false), tex).toBeNull();
    }
  });

  it("a \\href{javascript:...} attempt renders inert: never a link; shown as its raw text", () => {
    for (const tex of [String.raw`\href{javascript:alert(1)}{click}`, String.raw`\url{javascript:alert(1)}`, String.raw`\htmlId{x}{y}`, String.raw`\includegraphics{x.png}`]) {
      expect(renderMath(tex, false), tex).toBeNull();
    }
    // And KaTeX itself, with trust off, makes no link or attribute from it.
    const raw = katex.renderToString(String.raw`\href{javascript:alert(1)}{click}`, { throwOnError: false, trust: false });
    expect(raw).not.toMatch(/<a\b|href=|id="x"/i);
  });

  it("HTML in the course text is escaped by KaTeX, never passed through", () => {
    const html = renderMath(String.raw`\text{<img src=x onerror=alert(1)>}`, false) ?? "";
    expect(html).not.toMatch(/<img/i);
  });

  it("the quote check still compares the raw text", () => {
    const page = `As shown, ${QUOTE} so W is spanned by two vectors.`;
    expect(quoteIn(page, QUOTE)).toBe(true);
  });
});
