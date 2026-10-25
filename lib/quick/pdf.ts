// Quick build (beta), in the browser: the course PDFs the student picks (slides, study guides) as text, page by page.
// pdf.js (unpdf's build) reads each file inside a Web Worker (lib/quick/pdf-worker.ts); nothing is uploaded. Only the
// pages' text is ever sent, as chunks that keep { deck, page } so a question can say "Slide 12 · <deck>".
//   - A page with no text (a scanned or image-only page) is skipped and counted, so the student is told.
//   - A file whose pages are mostly landscape is slides; otherwise it's a document (a study guide, notes).

/** The part of pdf.js's document this reads (so a test can hand it a real one, and nothing else is touched). */
export interface PdfLike {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
}

export interface PdfPage {
  /** 1-based, as the PDF numbers it. */
  page: number;
  text: string;
  landscape: boolean;
}

export interface PdfFile {
  /** The file name without its extension. */
  deck: string;
  kind: "slide" | "document";
  /** Pages with text, in order, each with its own number. */
  pages: { page: number; text: string }[];
  /** Pages with no text (image-only), not read. */
  skipped: number;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A page's text items as lines: one line per end-of-line pdf.js marks, whitespace collapsed. */
export function itemsToText(items: unknown[]): string {
  let out = "";
  for (const it of items) {
    if (!it || typeof it !== "object" || typeof (it as { str?: unknown }).str !== "string") continue;
    out += (it as { str: string }).str;
    if ((it as { hasEOL?: boolean }).hasEOL) out += "\n";
  }
  return (
    out
      .replace(CONTROL, " ")
      // A slide's code ("vector<int>") isn't HTML; a space after "<" keeps it text for the route's no-HTML check.
      .replace(/<(?=[!?/a-zA-Z])/g, "< ")
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  );
}

/** Every page's text, with its number and shape. */
export async function readPdfPages(doc: PdfLike): Promise<PdfPage[]> {
  const out: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    out.push({ page: n, text: itemsToText((await page.getTextContent()).items), landscape: width > height });
  }
  return out;
}

/** "Week 3 Slides.pdf" -> "Week 3 Slides": no extension, no HTML, at most 120 characters. */
export function deckName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return (
    base
      .replace(/\.[^.]+$/, "")
      .replace(CONTROL, " ")
      .replace(/[<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Untitled file"
  );
}

/** A file's pages as what the build reads: slides or a document, the pages with text, and how many had none. */
export function pdfFile(fileName: string, pages: PdfPage[]): PdfFile {
  const withText = pages.filter((p) => p.text.replace(/\s/g, "").length >= 3);
  const landscape = pages.filter((p) => p.landscape).length;
  return {
    deck: deckName(fileName),
    kind: pages.length && landscape * 2 > pages.length ? "slide" : "document",
    pages: withText.map((p) => ({ page: p.page, text: p.text })),
    skipped: pages.length - withText.length,
  };
}
