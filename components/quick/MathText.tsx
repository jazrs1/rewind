"use client";

// Quick build's text renderer for the sheet: "$...$" and "$$...$$" drawn with KaTeX (lib/quick/math.ts), everything else
// as text. Wide math (a bmatrix) scrolls sideways inside its own box, so it never widens the sheet at 390 px.

import "katex/dist/katex.min.css";
import type { ReactNode } from "react";
import { hasMath, mathParts, renderMath } from "@/lib/quick/math";

export function mathText(text: string): ReactNode {
  if (!hasMath(text)) return text;
  return mathParts(text).map((p, i) => {
    if (p.kind === "text") return p.text;
    const html = renderMath(p.tex, p.display);
    if (html === null) return p.raw;
    return (
      <span
        key={i}
        data-quick-math={p.display ? "display" : "inline"}
        className={p.display ? "my-1 block max-w-full overflow-x-auto overflow-y-hidden py-1" : "inline-block max-w-full overflow-x-auto overflow-y-hidden align-middle"}
        // KaTeX's own output: it escapes all text, and trust: false keeps links and HTML commands out.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  });
}
