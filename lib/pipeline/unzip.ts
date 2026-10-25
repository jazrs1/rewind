// Unpacks the student's Files-tab .zip (T17) into <name>.unzipped/ next to it, under private/.
// zipEntries/zipEntryBytes (download.ts) decide which entries are safe to read; this decides
// where they may be written (the guards live in private-fs.ts):
//   - the private root is pinned: realpath(privateRoot) must be the real private folder
//     (REWIND_PRIVATE_ROOT, else the main checkout's private/). A worker worktree's private/
//     symlink to the main checkout's resolves to it and is fine; a link anywhere else is refused.
//   - every folder on the way and the file's parent are resolved with realpath and must be
//     inside the real destination, which must be inside the real private root. A symlinked
//     folder inside the unzip area that points anywhere else is refused.
//   - files are written to a random `.rewind-<hex>.part` opened with O_EXCL | O_NOFOLLOW (never
//     through a planted symlink, and no zip entry's name can collide with it), then renamed into
//     place; an existing file is kept only if it's the same size.
//   - names that differ only in case (one file on macOS) are both kept: the later one gets a
//     " (2)" suffix and is reported.
//   - an entry with a path segment over 255 bytes is skipped and reported, not fatal.
//   - a zip over 2 GB can't be read into memory: it's reported, not unpacked.

import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_BYTES, zipEntries, zipEntryBytes } from "./download.ts";
import { MAX_NAME_BYTES, inside, realPrivateRoot, writeInside } from "./private-fs.ts";

export { inside };

/** Node can't read a file this large into one buffer. */
export const MAX_ZIP_READ = 2 * 1024 * 1024 * 1024 - 1;

export interface UnpackResult {
  /** Entries written this run (already-unpacked ones aren't counted). */
  written: number;
  /** Entries already on disk from an earlier run (same size). */
  kept: number;
  refused: { name: string; reason: string }[];
  /** Case-only duplicates kept under a new name. */
  renamed: { from: string; to: string }[];
}

const caseKey = (p: string) => p.normalize("NFC").toLowerCase();

/** "Week 1/Notes.pdf" -> "Week 1/Notes (2).pdf". */
function withSuffix(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)} (${n})${path.slice(dot)}` : `${path} (${n})`;
}

export async function unpackZip(
  zipPath: string,
  dest: string,
  privateRoot: string,
  opts: { maxRead?: number; maxBytes?: number; /** The pinned real private root (default: pinnedPrivateRoot()). */ pinnedRoot?: string } = {},
): Promise<UnpackResult> {
  const out: UnpackResult = { written: 0, kept: 0, refused: [], renamed: [] };
  const maxRead = opts.maxRead ?? MAX_ZIP_READ;
  if ((await stat(zipPath)).size > maxRead) {
    out.refused.push({ name: basename(zipPath), reason: "zip over 2 GB: unzip it in Finder instead" });
    return out;
  }
  const realRoot = await realPrivateRoot(privateRoot, opts.pinnedRoot);
  // The destination's parent must already be inside the real private root before anything is made.
  if (!inside(realRoot, await realpath(dirname(dest)))) throw new Error("the unzip folder isn't inside the real private/ folder");
  await mkdir(dest, { recursive: true });
  const realDest = await realpath(dest);
  if (!inside(realRoot, realDest) || realDest === realRoot) throw new Error("the unzip folder isn't inside the real private/ folder");

  const bytes = new Uint8Array(await readFile(zipPath));
  const { entries, refused } = zipEntries(bytes, opts.maxBytes ?? MAX_BYTES);
  out.refused.push(...refused);
  const seen = new Map<string, string>();
  for (const e of entries) {
    const refuse = (reason: string) => out.refused.push({ name: e.path, reason });
    let path = e.path;
    const first = seen.get(caseKey(path));
    if (first === path) {
      refuse("duplicate entry");
      continue;
    }
    if (first !== undefined) {
      let n = 2;
      while (seen.has(caseKey(withSuffix(e.path, n)))) n++;
      path = withSuffix(e.path, n);
      out.renamed.push({ from: e.path, to: path });
    }
    const segs = path.split("/");
    if (segs.some((s) => Buffer.byteLength(s) > MAX_NAME_BYTES)) {
      refuse(`a name on its path is over ${MAX_NAME_BYTES} bytes`);
      continue;
    }
    seen.set(caseKey(path), path);

    try {
      // Each folder on the way: made here, or an existing one whose real path is inside the destination.
      let dir = realDest;
      let ok = true;
      for (const s of segs.slice(0, -1)) {
        const next = join(dir, s);
        const have = await lstat(next).catch(() => null);
        if (!have) await mkdir(next);
        const real = await realpath(next);
        if (!inside(realDest, real) || !(await stat(real)).isDirectory()) {
          ok = false;
          break;
        }
        dir = real;
      }
      const name = segs[segs.length - 1];
      if (!ok || !inside(realDest, await realpath(dir))) {
        refuse("a folder on its path leads outside the unzip folder");
        continue;
      }
      const have = await lstat(join(dir, name)).catch(() => null);
      if (have?.isFile() && have.size === e.size) {
        out.kept++;
        continue;
      }
      if (have) {
        refuse("would overwrite something that isn't the same file");
        continue;
      }
      const data = zipEntryBytes(bytes, e, opts.maxBytes ?? MAX_BYTES);
      // Re-checks the folder is inside the real private root, writes a random O_EXCL temp file, renames it into place.
      await writeInside(realRoot, dir, name, data);
      out.written++;
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}
