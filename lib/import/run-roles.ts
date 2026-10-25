// Prints import role counts per course, after the rules and after the Flash-Lite pass, plus
// the Flash-Lite token usage this run logged. Counts only: no file names on stdout. The full
// list (name, role, reason) goes to private/import/<file>.roles.json for eyeballing.
//
// node --env-file=.env.local lib/import/run-roles.ts private/COP3530.course.json private/MAS3114.course.json

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { MODELS, generateJSON, geminiUsagePath } from "../gemini.ts";
import { classifyUnknowns, flashLiteClassifier } from "./classify.ts";
import { normalizeCourse } from "./normalize.ts";
import { IMPORT_ROLES, type CourseExport, type ImportItem } from "./types.ts";

function counts(items: ImportItem[]): string {
  const c = Object.fromEntries(IMPORT_ROLES.map((r) => [r, 0])) as Record<string, number>;
  for (const it of items) c[it.role]++;
  const unknownPct = items.length ? ((100 * c.unknown) / items.length).toFixed(1) : "0";
  return `${items.length} items: ${IMPORT_ROLES.map((r) => `${r} ${c[r]}`).join(", ")} (unknown ${unknownPct}%)`;
}

const started = new Date().toISOString();
const classify = flashLiteClassifier((m, p, s, o) => generateJSON(m, p, s, o), MODELS.flashLite);

for (const path of process.argv.slice(2)) {
  const exp = JSON.parse(await readFile(path, "utf8")) as CourseExport;
  const ruled = normalizeCourse(exp);
  const versions = ruled.items.reduce((n, it) => n + Math.max(0, (it.versions?.length ?? 0) - 1), 0);
  console.log(`${basename(path)}`);
  console.log(`  rules:      ${counts(ruled.items)}; ${versions} extra versions grouped into their decks`);
  const out = await classifyUnknowns(ruled, classify, { courseName: exp.course.name });
  console.log(`  classifier: ${counts(out.items)}`);
  console.log(`  classifier calls: ${JSON.stringify(out.classifier)}`);
  const dir = join(process.cwd(), "private", "import");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, basename(path).replace(/\.course\.json$/, "") + ".roles.json"),
    JSON.stringify(out.items.map((it) => ({ fileId: it.fileId, name: it.name, role: it.role, roleReason: it.roleReason, versions: it.versions })), null, 2),
  );
}

// Token usage logged by this run's uncached calls (cached calls log nothing).
let lines: string[] = [];
try {
  lines = (await readFile(geminiUsagePath(), "utf8")).split("\n").filter(Boolean);
} catch {
  /* no paid calls yet */
}
const mine = lines
  .map((l) => JSON.parse(l) as { at: string; model: string; usage: Record<string, number> | null })
  .filter((u) => u.at >= started && u.model === MODELS.flashLite);
const sum = (k: string) => mine.reduce((n, u) => n + (u.usage?.[k] ?? 0), 0);
console.log(
  `Flash-Lite this run: ${mine.length} paid calls, prompt ${sum("promptTokenCount")} tokens, ` +
    `output ${sum("candidatesTokenCount")} tokens, thinking ${sum("thoughtsTokenCount")} tokens`,
);
