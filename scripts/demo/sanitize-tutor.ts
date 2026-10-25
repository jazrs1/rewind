// Takes out of the saved tutor replies (public/demo/course/tutor.json) every chip the live rule wouldn't show
// (lib/tutor/poll.ts safeChips: before the student answers, nothing that gives the answer away, no poll or answer
// slide, not the question's own slide, no moment inside its explanation window). The words stay; no model is called.
//
//   node scripts/demo/sanitize-tutor.ts [--root <checkout>]
//
// scripts/demo/precompute-tutor.ts applies the same rule to a fresh file; this fixes a file made before it.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_DIR, readDemoBundle } from "../../lib/demo/bundle.ts";
import { sanitizeSaved, validateSaved } from "../../lib/demo/tutor-saved.ts";
import type { SavedFile } from "../../lib/demo/tutor-pick.ts";

const args = process.argv.slice(2);
const rootArg = args.indexOf("--root");
const root = rootArg >= 0 ? args[rootArg + 1] : process.cwd();
const path = join(root, "public", BUNDLE_DIR, "tutor.json");
const bundle = await readDemoBundle(root);
if (!bundle) {
  console.error("No demo bundle (public/demo/course/course.json).");
  process.exit(1);
}
const file = JSON.parse(readFileSync(path, "utf8")) as SavedFile;
const count = (f: SavedFile) => Object.values(f.questions).flatMap((e) => Object.values(e).flatMap((r) => (r && "grounded" in r ? (r.grounded ?? []) : []))).length;
const clean = sanitizeSaved(file, bundle);
const errors = validateSaved(clean, bundle);
if (errors.length) {
  console.error(`${errors.length} problems, nothing written (first: ${errors[0]})`);
  process.exit(1);
}
writeFileSync(path, JSON.stringify(clean, null, 2) + "\n");
console.log(`tutor.json: ${count(file) - count(clean)} of ${count(file)} chips taken out; ${Object.keys(clean.questions).length} questions`);
