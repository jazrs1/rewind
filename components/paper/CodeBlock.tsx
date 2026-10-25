// Code in a question, printed on the exam sheet: monospace ink on a faint print-green ground with a
// print-green rule down its left, line numbers in print green, no syntax colours. Long lines wrap at
// every width, so nothing hides behind a sideways scroll (the decisive line may be the long one); a
// wrapped line continues under its own indentation (under its number when it has none). The block
// takes keyboard focus.

export interface QuestionCode {
  language: string;
  lines: string[];
}

/** The line number's column (globals.css .code-lines: 3.5ch wide, its 1.5ch gap inside, border-box). */
const NUMBER_CH = 3.5;
const TAB = 4;

/** A line with its leading tabs as spaces, and how many columns it is indented. */
export function codeIndent(line: string): { text: string; cols: number } {
  const lead = line.match(/^[ \t]*/)![0];
  const spaces = lead.replace(/\t/g, " ".repeat(TAB));
  return { text: spaces + line.slice(lead.length), cols: spaces.length };
}

/** `compact`: the missed strip's card: every line (3-8 by rule; never cut, the answer may depend on the last). */
export function CodeBlock({ code, n, compact = false, className = "" }: { code: QuestionCode; n: number; compact?: boolean; className?: string }) {
  return (
    <pre
      role="group"
      aria-label={`Code for question ${n}`}
      data-code=""
      data-language={code.language}
      tabIndex={compact ? undefined : 0}
      className={`code-lines rounded-r-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-print max-w-full min-w-0 overflow-x-auto border-l-[3px] border-print bg-print/[0.07] py-2.5 pr-4 font-mono text-[13px] leading-[1.6] text-ink ${compact ? "shrink-0" : "lg:py-3 lg:text-[15px]"} ${className}`}
    >
      <code>
        {code.lines.map((line, i) => {
          const { text, cols } = codeIndent(line);
          const hang = `${NUMBER_CH + cols}ch`;
          return (
            <span key={i} data-indent={cols} className="block whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ paddingLeft: hang, textIndent: `-${hang}` }}>
              {text || " "}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
