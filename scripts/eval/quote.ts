// Word-for-word quote check. Case, punctuation, curly quotes and spacing are ignored;
// the words themselves must appear in the same order with nothing added, dropped or
// elided ("..." fails). A timestamp label like [14:29] in the quote is dropped first,
// since the prompt shows lines with their times.

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, " ")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9'|^()=+\-*/<>%]+/g, " ")
    .replace(/(^|\s)'+|'+(\s|$)/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function quoteAppears(quote: string, sources: string[]): boolean {
  if (/\.\.\.|…/.test(quote)) return false;
  const q = words(quote);
  if (q.length < 3) return false;
  const needle = ` ${q.join(" ")} `;
  return sources.some((s) => ` ${words(s).join(" ")} `.includes(needle));
}

/** The words a quote is compared on (same normalization as quoteAppears). */
export { words as quoteWords };
