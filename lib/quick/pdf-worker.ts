// Quick build (beta): reads one PDF in a Web Worker so the page stays responsive. In: { id, data } (the file's bytes).
// Out: { id, pages } (each page's text, number and shape) or { id, error: true }. Nothing leaves the browser.

import { getDocumentProxy } from "unpdf";
import { readPdfPages, type PdfLike } from "./pdf.ts";

const ctx = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; data: ArrayBuffer }>) => void) | null; postMessage(m: unknown): void };

ctx.onmessage = async (e) => {
  const { id, data } = e.data;
  try {
    const doc = await getDocumentProxy(new Uint8Array(data));
    try {
      ctx.postMessage({ id, pages: await readPdfPages(doc as unknown as PdfLike) });
    } finally {
      await (doc as unknown as { destroy?: () => Promise<unknown> }).destroy?.().catch(() => {});
    }
  } catch {
    ctx.postMessage({ id, error: true });
  }
};
