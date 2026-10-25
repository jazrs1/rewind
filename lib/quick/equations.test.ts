// Canvas page HTML to text keeps every equation: an equation image becomes its LaTeX, inline as $...$ (synthetic pages).
import { describe, expect, it } from "vitest";
import { equationText, htmlToText, pageChunks } from "./export.ts";
import { parseRequest } from "./schema.ts";

/** A stand-in for DOMParser's nodes: a tag, attributes, children (or text). */
type N = { nodeType: 1 | 3; tagName?: string; nodeValue?: string; textContent?: string; childNodes: N[]; getAttribute?: (n: string) => string | null };
const el = (tagName: string, attrs: Record<string, string> = {}, ...kids: N[]): N => ({
  nodeType: 1,
  tagName,
  childNodes: kids,
  textContent: kids.map((k) => k.nodeValue ?? k.textContent ?? "").join(""),
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
});
const tx = (nodeValue: string): N => ({ nodeType: 3, nodeValue, childNodes: [] });
const page = (...kids: N[]) => htmlToText("ignored", () => ({ body: el("BODY", {}, ...kids) }) as unknown as Document);

const MATRIX = String.raw`A = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}`;
const eqImg = (attrs: Record<string, string>) => el("IMG", { class: "equation_image", src: "/equation_images/x?scale=1", ...attrs });

describe("equation images in Canvas pages", () => {
  it("a synthetic page with an equation image and a matrix keeps both, inline, in order", () => {
    const text = page(
      el("H2", {}, tx("Determinants")),
      el("P", {}, tx("For a 2 by 2 matrix,"), eqImg({ "data-equation-content": String.raw`\det(A) = ad - bc`, alt: String.raw`LaTeX: \det(A) = ad - bc` }), tx("so the determinant of")),
      el("P", {}, eqImg({ "data-equation-content": MATRIX, title: MATRIX }), tx("is -2.")),
      el("P", {}, el("IMG", { src: "/courses/1/files/2/preview", alt: "photo of the board" }), tx("A picture that isn't an equation is left out.")),
    );
    expect(text).toBe(["Determinants", String.raw`For a 2 by 2 matrix, $\det(A) = ad - bc$ so the determinant of`, `$${MATRIX}$ is -2.`, "A picture that isn't an equation is left out."].join("\n"));
  });

  it("the LaTeX comes from data-equation-content, else alt (without its \"LaTeX:\" label), else title, else the MathML's text", () => {
    expect(equationText(eqImg({ "data-equation-content": "x^2", alt: "LaTeX: y^2" }) as unknown as Element)).toBe("$x^2$");
    expect(equationText(eqImg({ alt: "LaTeX: y^2" }) as unknown as Element)).toBe("$y^2$");
    expect(equationText(el("IMG", { src: "https://canvas.example/equation_images/z", title: String.raw`\sqrt{2}` }) as unknown as Element)).toBe(String.raw`$\sqrt{2}$`);
    expect(equationText(el("IMG", { "data-mathml": '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>+</mo><mn>1</mn></math>' }) as unknown as Element)).toBe("$x + 1$");
    expect(equationText(el("IMG", { src: "/files/1", alt: "a cat" }) as unknown as Element)).toBeNull();
  });

  it("Canvas's screen-reader MathML beside the image isn't a second copy; MathML on its own is kept", () => {
    expect(page(el("P", {}, eqImg({ "data-equation-content": "x^2" }), el("MATH", {}, tx("x 2")), tx("grows.")))).toBe("$x^2$ grows.");
    expect(page(el("P", {}, tx("Here"), el("MATH", {}, tx("x + 1")), tx("is linear.")))).toBe("Here $x + 1$ is linear.");
  });

  it("an inequality is not mistaken for HTML: the chunk still passes the route's no-HTML check", () => {
    const text = page(el("P", {}, tx("We need"), eqImg({ "data-equation-content": String.raw`a<b \text{ and } c>d` }), tx("for every pair in the set we are studying here, written out in full so the passage is long enough to send.")));
    expect(text).toContain(String.raw`$a< b \text{ and } c>d$`);
    const chunks = pageChunks([{ title: "Inequalities", text }]);
    expect(parseRequest(JSON.stringify({ course: { code: "MAS3114", name: "Computational Linear Algebra" }, chunks })).ok).toBe(true);
  });

  it("a matrix chunk passes the route's schema as it is", () => {
    const text = page(el("P", {}, tx("The matrix"), eqImg({ "data-equation-content": MATRIX }), tx("has determinant -2, since ad - bc = 4 - 6. Row reducing it gives the identity, so it is invertible.")));
    const chunks = pageChunks([{ title: "Matrices", text }]);
    expect(chunks[0].text).toContain(String.raw`\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}`);
    expect(parseRequest(JSON.stringify({ course: { code: "MAS3114", name: "Computational Linear Algebra" }, chunks })).ok).toBe(true);
  });
});
