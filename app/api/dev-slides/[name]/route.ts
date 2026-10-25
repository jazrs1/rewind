// Dev only: serves slide renders from private/demo/slides/ (real course content, never deployed).
// Names: "<slug>-<hash>-p<page>.png" (lib/pipeline/run.ts slideImageName) or the older
// "<slug>-p<page>.png" (spike seeds, earlier pipeline runs). A new-style name whose image hasn't
// been rendered yet falls back to the older name for the same deck and page.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDemoMode } from "@/lib/demo/guard";
import { legacySlideName } from "@/lib/pipeline/run";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  if (process.env.NODE_ENV !== "development" || isDemoMode()) return new Response("Not found", { status: 404 });
  const { name } = await ctx.params;
  if (!/^[a-z0-9-]+\.png$/.test(name)) return new Response("Not found", { status: 404 });
  // private/demo/slides first; e2e/fixtures/slides holds the invented renders for /practice?set=e2e-fixture.
  for (const dir of ["private/demo/slides", "e2e/fixtures/slides"]) {
    for (const candidate of [name, legacySlideName(name)]) {
      if (!candidate) continue;
      try {
        const png = await readFile(join(process.cwd(), dir, candidate));
        return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
      } catch {
        // try the next name
      }
    }
  }
  return new Response("Not found", { status: 404 });
}
