import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOWNLOAD_DISABLED, type DownloadDeps, type DownloadTarget } from "./download";
import { downloadStage, networkEnabled } from "./download-stage";
import { checkCourseCode } from "./private-fs";

/** Read-only fs names a pipeline file may import by name (anything else, writeSync or promises included, is refused). */
const FS_READS = new Set(["readFile", "readdir", "lstat", "stat", "realpath", "access", "constants", "readFileSync", "readdirSync", "lstatSync", "statSync", "realpathSync", "existsSync", "Dirent", "Stats"]);

/**
 * Every way a source file reaches fs other than a read-only named import: any "fs" /
 * "node:fs" / "fs/promises" / "node:fs/promises" string in either quote style that isn't part of
 * `import { reads } from "..."` (or `import type`), any dynamic import(), require( or createRequire.
 * `allowedLines` are exact lines of the file that are exempt.
 */
function fsViolations(src: string, allowedLines: string[]): string[] {
  const ranges = (re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true) =>
    [...src.matchAll(re)].filter(keep).map((m) => [m.index!, m.index! + m[0].length] as const);
  const allowed = allowedLines.flatMap((line) => ranges(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")));
  const safe = ranges(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*(["'])(?:node:)?fs(?:\/promises)?\3/g, (m) =>
    !!m[1] || m[2].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean).every((n) => FS_READS.has(n)));
  const within = (i: number, rs: (readonly [number, number])[]) => rs.some(([a, b]) => i >= a && i < b);
  const lineAt = (i: number) => src.slice(src.lastIndexOf("\n", i) + 1, (src.indexOf("\n", i) + 1 || src.length + 1) - 1).trim();
  const out: string[] = [];
  for (const m of src.matchAll(/(["'`])(?:node:)?fs(?:\/promises)?\1/g)) if (!within(m.index!, safe) && !within(m.index!, allowed)) out.push(`fs reference: ${lineAt(m.index!)}`);
  for (const m of src.matchAll(/\bcreateRequire\b|\brequire\s*\(|\bimport\s*\(/g)) if (!within(m.index!, allowed)) out.push(`dynamic load: ${lineAt(m.index!)}`);
  return out;
}

// Invented course data only.
const t = (fileId: number, name: string, size?: number): DownloadTarget =>
  ({ fileId, itemId: `file:${fileId}`, name, role: "lecture", ext: "pdf", url: `https://ufl.instructure.com/files/${fileId}/download?download_frd=1`, size });

function deps(): DownloadDeps & { fetches: string[] } {
  const fetches: string[] = [];
  const written = new Map<string, Uint8Array>();
  return {
    fetches,
    fetch: async (url) => {
      fetches.push(url);
      throw new Error(`a default run must never fetch (asked for ${url})`);
    },
    exists: async (f) => written.has(f),
    write: async (f, b) => void written.set(f, b),
    rename: async (a, b) => {
      written.set(b, written.get(a)!);
      written.delete(a);
    },
    remove: async (f) => void written.delete(f),
    copyLocal: async (_p, tmp) => void written.set(tmp, new Uint8Array(1)),
  };
}

describe("download stage (every entry point)", () => {
  it("network is off unless --download or REWIND_ENABLE_DOWNLOAD=1", () => {
    expect(networkEnabled(["node", "scripts/pipeline/run.ts", "--course", "COP3530"], {})).toBe(false);
    expect(networkEnabled([], { REWIND_ENABLE_DOWNLOAD: "true" })).toBe(false);
    expect(networkEnabled(["--download"], {})).toBe(true);
    expect(networkEnabled([], { REWIND_ENABLE_DOWNLOAD: "1" })).toBe(true);
  });

  it("a default invocation makes 0 fetches: missing files are \"download disabled\", local ones still copy", async () => {
    const d = deps();
    const r = await downloadStage([t(1, "Heaps.pdf", 5), t(2, "Graphs.pdf"), t(3, "Tries.pdf")], [{ path: "w/Heaps.pdf", name: "Heaps.pdf", size: 5 }], d, {
      argv: ["node", "scripts/pipeline/run.ts", "--course", "FAKE1"],
      env: {},
    });
    expect(d.fetches).toEqual([]);
    expect(r.network).toBe(false);
    expect(r.downloads.map((x) => [x.fileId, x.status, x.reason ?? null])).toEqual([[1, "local", null], [2, "failed", DOWNLOAD_DISABLED], [3, "failed", DOWNLOAD_DISABLED]]);
  });

  it("--course is a plain course code everywhere (no `..`, no separators)", () => {
    expect(checkCourseCode("COP3530")).toBe("COP3530");
    for (const bad of ["../../x", "COP3530/..", "cop3530", "", "A".repeat(33), "COP 3530"]) expect(() => checkCourseCode(bad), bad).toThrow();
    for (const f of readdirSync(join(process.cwd(), "scripts/pipeline")).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(process.cwd(), "scripts/pipeline", f), "utf8");
      if (/arg\("course"\)/.test(src)) expect(src, f).toMatch(/checkCourseCode\(arg\("course"\)/);
    }
  });

  it("the fs checker catches every way round it (single quotes, default/namespace, promises, writeSync, dynamic import, require)", () => {
    const dodges = [
      'import { writeFile } from "node:fs/promises";',
      'import { writeFile as wf } from "fs/promises";',
      'import * as fs from "node:fs";',
      'import fs from "fs";',
      'import fs, { readFile } from "node:fs";',
      "import { writeFile } from 'node:fs/promises';",
      'import { promises } from "node:fs";',
      'import { openSync as o, writeSync } from "node:fs";',
      'import { readFile, writeSync } from "node:fs";',
      'const fs = await import("node:fs/promises");',
      "const m = 'node:fs'; const fs = await import(m);",
      'import { createRequire } from "node:module"; const fs = createRequire(import.meta.url)("fs");',
      'const fs = require("fs");',
      'export { writeFile } from "node:fs/promises";',
      'import {\n  readFile,\n  writeFile,\n} from "node:fs/promises";',
    ];
    for (const src of dodges) expect(fsViolations(src, []), src).not.toEqual([]);
    // Read-only named imports (and type-only imports) are fine.
    for (const src of ['import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";', "import { readFileSync } from 'node:fs';", 'import type { Stats } from "node:fs";'])
      expect(fsViolations(src, []), src).toEqual([]);
  });

  it("no raw fs access in scripts/pipeline or lib/pipeline (recursive): every write goes through private-fs.ts", () => {
    // Only exceptions: private-fs.ts itself, and unzip.ts's import (its mkdir checks each folder's realpath).
    const allowed: Record<string, string[] | "all"> = {
      "lib/pipeline/private-fs.ts": "all",
      "lib/pipeline/unzip.ts": ['import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";'],
    };
    const files = ["scripts/pipeline", "lib/pipeline"].flatMap((dir) =>
      (readdirSync(join(process.cwd(), dir), { recursive: true }) as string[])
        .filter((f) => /\.(c|m)?(t|j)sx?$/.test(f) && !/\.test\.(c|m)?(t|j)sx?$/.test(f))
        .map((f) => `${dir}/${f.split("\\").join("/")}`),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const allow = allowed[path];
      if (allow === "all") continue;
      expect(fsViolations(readFileSync(join(process.cwd(), path), "utf8"), allow ?? []), path).toEqual([]);
    }
  });

  it("scripts only download through downloadStage (no direct downloadAll, no fetch of their own)", () => {
    for (const f of ["scripts/pipeline/run.ts", "scripts/pipeline/front-half.ts"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/downloadStage\(/);
      expect(src, f).not.toMatch(/downloadAll\(/);
      expect(src, f).toMatch(/argv: process\.argv, env: process\.env/);
    }
  });
});
