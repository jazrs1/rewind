// Lists the Gemini models on our key and picks the IDs we use.
// Run: npm run spike:models  (add --write to update docs/BRIEF.md)

import { readFile, writeFile } from "node:fs/promises";
import { listModels, MODELS, type ModelInfo } from "../../lib/gemini.ts";

const ROLES: { role: keyof typeof MODELS; label: string; action: string; pattern: RegExp }[] = [
  { role: "flash", label: "Flash", action: "generateContent", pattern: /^gemini-[\d.]+-flash$/ },
  { role: "flashLite", label: "Flash-Lite", action: "generateContent", pattern: /^gemini-[\d.]+-flash-lite$/ },
  { role: "embed", label: "Embeddings", action: "embedContent", pattern: /^gemini-embedding/ },
  { role: "transcribe", label: "Transcribe", action: "", pattern: /transcribe/ },
];

// Newest version number wins: gemini-3.8-flash beats gemini-3.5-flash.
function version(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function pick(models: ModelInfo[], r: (typeof ROLES)[number]): ModelInfo | null {
  const expected = models.find((m) => m.name === MODELS[r.role]);
  if (expected) return expected;
  const candidates = models
    .filter((m) => r.pattern.test(m.name) && !/preview|exp/.test(m.name))
    .filter((m) => !r.action || m.supportedActions.includes(r.action))
    .sort((a, b) => version(b.name) - version(a.name));
  return candidates[0] ?? null;
}

async function main() {
  const models = await listModels();
  console.log(`${models.length} models on this key:\n`);
  for (const m of models.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${m.name.padEnd(42)} ${m.supportedActions.join(", ")}`);
  }

  const lines: string[] = [];
  console.log("\nPicked:");
  for (const r of ROLES) {
    const m = pick(models, r);
    const note = !m ? "NOT FOUND" : m.name === MODELS[r.role] ? "as expected" : `expected ${MODELS[r.role]}`;
    console.log(`  ${r.label.padEnd(11)} ${m?.name ?? "-"}  (${note})`);
    lines.push(`- ${r.label}: ${m ? `\`${m.name}\`` : `not found (expected \`${MODELS[r.role]}\`)`}`);
  }

  if (process.argv.includes("--write")) {
    const path = "docs/BRIEF.md";
    const section = `## Models on our key\n\nListed by \`npm run spike:models\` on ${new Date().toISOString().slice(0, 10)}. \`MODELS\` in \`lib/gemini.ts\` must match.\n\n${lines.join("\n")}\n`;
    let brief = await readFile(path, "utf8");
    const re = /## Models on our key\n[\s\S]*?(?=\n## |$)/;
    brief = re.test(brief) ? brief.replace(re, section) : brief.trimEnd() + "\n\n" + section;
    await writeFile(path, brief);
    console.log(`\nWrote "Models on our key" to ${path}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
