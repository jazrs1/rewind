// The student's own download of the Files tab, private/files/<COURSE>/ (T17 download path B),
// shared by front-half.ts and run.ts: loose files or Canvas's .zip, unpacked next to it into
// <name>.unzipped/ by lib/pipeline/unzip.ts (guarded writes inside the pinned real private root,
// safe paths only). Lists every regular file under the folder (symlinks skipped); matching to the
// export is lib/pipeline/download.ts's matchLocal. Real course data: never print the paths.

import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LocalFile } from "../../lib/pipeline/download.ts";
import { unpackZip } from "../../lib/pipeline/unzip.ts";

const isDir = (p: string) => lstat(p).then((s) => s.isDirectory(), () => false);

/** Regular files under `root` (symlinks skipped, hidden files and the zips themselves left out), paths relative to it. */
async function listLocal(root: string, rel = ""): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const d of await readdir(join(root, rel), { withFileTypes: true })) {
    if (d.name.startsWith(".") || d.name === "__MACOSX" || d.isSymbolicLink()) continue;
    const path = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await listLocal(root, path)));
    else if (d.isFile() && !d.name.toLowerCase().endsWith(".zip") && !d.name.endsWith(".part")) out.push({ path, name: d.name, size: (await lstat(join(root, path))).size });
  }
  return out;
}

export interface LocalFolder {
  /** private/files/<COURSE>/ (resolved; its real path is checked by every read and write). */
  dir: string;
  files: LocalFile[];
  unzip: { zips: number; entries: number; kept: number; renamedCaseOnly: number; refused: Record<string, number> };
}

/** `privateLink` is the checkout's private/ (it may be a symlink to the main checkout's). */
export async function loadLocalFolder(code: string, privateLink: string = resolve("private")): Promise<LocalFolder> {
  const dir = join(privateLink, "files", code);
  const unzip = { zips: 0, entries: 0, kept: 0, renamedCaseOnly: 0, refused: {} as Record<string, number> };
  if (!(await isDir(dir))) return { dir, files: [], unzip };
  for (const z of (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".zip"))) {
    // Writes stay inside the REAL private/ (realpath; private/ may itself be a symlink to the main checkout's).
    const r = await unpackZip(join(dir, z.name), join(dir, `${z.name.replace(/\.zip$/i, "")}.unzipped`), privateLink);
    unzip.zips++;
    unzip.entries += r.written;
    unzip.kept += r.kept;
    unzip.renamedCaseOnly += r.renamed.length;
    for (const x of r.refused) unzip.refused[x.reason] = (unzip.refused[x.reason] ?? 0) + 1;
  }
  return { dir, files: await listLocal(dir), unzip };
}
