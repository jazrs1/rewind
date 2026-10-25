// Caveat (the hand font) is only for values: numbers, dates and times (tape chips, the margin note's time) and
// single answer letters (John, Oct 24: its lowercase r and i read like o, so words never use it, and it is never
// under 18 px). HandValues sets a line in the UI sans and only its values in Caveat, in the same colour.

import type { ReactNode } from "react";

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
/** A value Caveat may set: "Oct 22", "57:43", "1:02:03", "19", "(C)". */
export const HAND_VALUE = new RegExp(`(${MONTH} \\d{1,2}|\\d{1,2}:\\d{2}(?::\\d{2})?|\\(?\\b[A-E]\\)|\\d+)`, "g");
/** Text that is nothing but values (dates, times, numbers, letters), so the whole of it may be set in Caveat. */
export const isHandValue = (text: string) => text.replace(HAND_VALUE, "").replace(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun|AM|PM)\b/g, "").replace(/[\s·,.:–\-/→◀()]/g, "") === "";

export function HandValues({ text, handClass = "" }: { text: string; handClass?: string }): ReactNode {
  const parts = text.split(HAND_VALUE);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className={`font-hand ${handClass}`}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}
