// npm run lint:design, static half: hex colours, fonts and motion outside the tokens (errors), type sizes
// off the scale (a warning; --strict makes them errors). Then the package script runs the rendered half
// (e2e/design-lint.spec.ts: tap targets, one primary per screen).
import { lintTree } from "../../lib/design/lint.ts";

const strict = process.argv.includes("--strict");
const all = lintTree(process.cwd());
const errors = all.filter((f) => f.rule !== "type" || strict);
const warnings = all.filter((f) => f.rule === "type" && !strict);
for (const f of errors) console.error(`error  ${f.rule.padEnd(6)} ${f.file}:${f.line}  ${f.text}`);
if (warnings.length) {
  const byFile = new Map<string, number>();
  for (const w of warnings) byFile.set(w.file, (byFile.get(w.file) ?? 0) + 1);
  console.log(`warn   type   ${warnings.length} sizes off the 13/15/18/22/30/44 scale (mockup-pinned sizes; --strict to list): ${[...byFile].map(([f, n]) => `${f} ${n}`).join(", ")}`);
}
console.log(errors.length ? `lint:design: ${errors.length} problems` : "lint:design: no hex, font or motion problems");
process.exit(errors.length ? 1 : 0);
