// Quick build (beta), in the browser: reads the picked PDFs one at a time in a Web Worker (lib/quick/pdf-worker.ts), so
// the page stays responsive. The files never leave the browser; what comes back is each page's text.

import { pdfFile, type PdfFile, type PdfPage } from "./pdf.ts";

/** A PDF larger than this isn't read (a course deck is a few MB; a scanned book would only be skipped pages). */
export const MAX_PDF_BYTES = 60 * 1024 * 1024;
const FILE_MS = 60_000;

export interface PdfRead {
  pdfs: PdfFile[];
  /** Files that couldn't be read (damaged, protected, too large, or too slow). */
  failed: string[];
}

export async function readPdfs(files: File[], onFile?: (done: number) => void): Promise<PdfRead> {
  const out: PdfRead = { pdfs: [], failed: [] };
  if (!files.length) return out;
  const worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), { type: "module" });
  try {
    for (const [i, f] of files.entries()) {
      const pages = f.size > MAX_PDF_BYTES ? null : await readOne(worker, i, f);
      if (pages) out.pdfs.push(pdfFile(f.name, pages));
      else out.failed.push(f.name);
      onFile?.(i + 1);
    }
  } finally {
    worker.terminate();
  }
  return out;
}

async function readOne(worker: Worker, id: number, f: File): Promise<PdfPage[] | null> {
  let data: ArrayBuffer;
  try {
    data = await f.arrayBuffer();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const done = (pages: PdfPage[] | null) => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      resolve(pages);
    };
    const onMessage = (e: MessageEvent<{ id: number; pages?: PdfPage[]; error?: true }>) => {
      if (e.data?.id === id) done(Array.isArray(e.data.pages) ? e.data.pages : null);
    };
    // The worker itself failed (it couldn't load): this file isn't read, and neither will the rest be, quickly.
    const onError = () => done(null);
    const timer = setTimeout(() => done(null), FILE_MS);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ id, data }, [data]);
  });
}
