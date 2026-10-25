"use client";

// How the sheet draws a question's own words (stem, choices, the quote card). Plain text, unless a screen provides a
// renderer: Quick build gives one that draws "$...$" as math (components/quick/MathText.tsx). The demo and the course
// screens provide none, so they draw exactly as before.

import { createContext, useContext, type ReactNode } from "react";

export const RichTextContext = createContext<((text: string) => ReactNode) | null>(null);

export function Rich({ text }: { text: string }) {
  const render = useContext(RichTextContext);
  return <>{render ? render(text) : text}</>;
}
