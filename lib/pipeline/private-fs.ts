// Guarded writes under private/ (T17). Every file the pipeline writes from course data goes
// through here (unzip.ts, and the download/local-copy/seed writes in scripts/pipeline/front-half.ts):
//   - the private root is PINNED: realpath(REWIND_PRIVATE_ROOT) if set, else
//     realpath(<main checkout>/private), the main checkout being the parent of
//     `git rev-parse --git-common-dir`. A worker worktree's private/ is a symlink to the main
//     checkout's and resolves to the same real folder, so it passes; a private/ (or a
//     private/pipeline, ...) that leads anywhere else is refused.
//   - before each write the folder's real path is checked to be inside the real private root;
//   - files are created with O_EXCL | O_NOFOLLOW (never through a planted symlink); a leftover
//     temp file is unlinked first (rm removes the link itself, never its target);
//   - target folders are made one segment at a time and a symlinked one is refused.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Is `child` (a real path) `parent` or inside it? */
export const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** A course code becomes a folder under private/: capital letters and digits only (no `..`, no separators). */
export const COURSE_CODE = /^[A-Z0-9]{1,32}$/;

/** The --course argument, refused unless it is a plain course code like COP3530. */
export function checkCourseCode(code: string): string {
  if (!COURSE_CODE.test(code)) throw new Error("--course must be a course code like COP3530 (A-Z and 0-9 only)");
  return code;
}

/** Most filesystems (APFS included) refuse a name over 255 bytes. */
export const MAX_NAME_BYTES = 255;

/** One path segment we may create: no separators, no `.`/`..`, no NUL, at most 255 bytes. */
export const plainName = (n: string) =>
  n.length > 0 && n !== "." && n !== ".." && !n.includes("/") && !n.includes("\\") && !n.includes("\0") && Buffer.byteLength(n) <= MAX_NAME_BYTES;

/**
 * The real private root every write must stay in: realpath(REWIND_PRIVATE_ROOT) if set, else
 * realpath(<main checkout>/private), found from `git rev-parse --git-common-dir` (whose parent is
 * the main checkout even from a worker worktree).
 */
export async function pinnedPrivateRoot(opts: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  let root: string;
  if (env.REWIND_PRIVATE_ROOT) root = resolve(cwd, env.REWIND_PRIVATE_ROOT);
  else {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    root = join(dirname(resolve(cwd, common)), "private");
  }
  try {
    return await realpath(root);
  } catch {
    throw new Error(`the private folder (${root}) doesn't exist`);
  }
}

/** realpath(privateRoot), which must be the pinned real private root (pass `pinned` to skip the lookup). */
export async function realPrivateRoot(privateRoot: string, pinned?: string): Promise<string> {
  const want = pinned ?? (await pinnedPrivateRoot());
  const real = await realpath(privateRoot);
  if (real !== want) throw new Error(`private/ doesn't lead to the real private folder (${want})`);
  return real;
}

/** The folder's real path, which must be inside the real private root (and not the root itself). */
async function checkDir(realRoot: string, dir: string): Promise<string> {
  const real = await realpath(dir);
  if (!inside(realRoot, real) || real === realRoot) throw new Error("the folder isn't inside the real private/ folder");
  if (!(await lstat(real)).isDirectory()) throw new Error("not a folder");
  return real;
}

/**
 * Makes <realRoot>/<segs...> one segment at a time and returns its real path. A segment that is a
 * symlink (or not a folder) is refused, so a symlinked private/pipeline/<COURSE>/files can't
 * redirect writes, even to somewhere else inside private/.
 */
export async function ensureDirInside(realRoot: string, segs: string[]): Promise<string> {
  let dir = realRoot;
  for (const s of segs) {
    if (!plainName(s)) throw new Error(`bad folder name: ${s}`);
    const next = join(dir, s);
    let have = await lstat(next).catch(() => null);
    if (!have) {
      await mkdir(next).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      have = await lstat(next);
    }
    if (have.isSymbolicLink()) throw new Error(`${join(...segs)}: a folder on the way is a symlink; refusing to write through it`);
    if (!have.isDirectory()) throw new Error(`${join(...segs)}: not a folder`);
    dir = next;
  }
  return checkDir(realRoot, dir);
}

const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Creates `path` (which must not exist) and writes `data`; never follows a symlink. */
async function createNew(path: string, data: Uint8Array): Promise<void> {
  const fh = await open(path, NEW_FILE, 0o644);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/** A temp name in the same folder that no zip entry or download can collide with. */
export const tempName = () => `.rewind-${randomBytes(8).toString("hex")}.part`;

/**
 * Writes `data` as `dir/name`: the folder's real path must be inside the real private root; the
 * bytes go to a fresh temp file opened with O_EXCL | O_NOFOLLOW, then renamed into place. Without
 * `replace`, anything already at `name` (a file, a folder, a symlink) is an error; with it, an
 * existing regular file is replaced (a symlink or folder is still an error).
 */
export async function writeInside(realRoot: string, dir: string, name: string, data: Uint8Array | string, opts: { replace?: boolean } = {}): Promise<void> {
  if (!plainName(name)) throw new Error(`bad file name: ${name}`);
  const realDir = await checkDir(realRoot, dir);
  const to = join(realDir, name);
  const tmp = join(realDir, tempName());
  await createNew(tmp, typeof data === "string" ? new TextEncoder().encode(data) : data);
  try {
    const have = await lstat(to).catch(() => null);
    if (have && !(opts.replace && have.isFile())) throw new Error(`${name}: something is already there`);
    await rename(tmp, to);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Reads a regular file whose real path is inside `realBase`, never following a symlink at the file itself. */
export async function readInside(realBase: string, path: string): Promise<Uint8Array> {
  const real = await realpath(dirname(path));
  if (!inside(realBase, real)) throw new Error("the source isn't inside its folder");
  const fh = await open(join(real, basename(path)), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await fh.stat()).isFile()) throw new Error("the source isn't a regular file");
    return new Uint8Array(await fh.readFile());
  } finally {
    await fh.close();
  }
}

/**
 * The file operations downloadAll needs, confined to the real folder `filesDir` (made with
 * ensureDirInside) under the real private root. Names are single segments. Before every write the
 * folder is re-checked; temp files are created with O_EXCL | O_NOFOLLOW after unlinking any leftover
 * (a planted `.part` symlink is removed, never followed); `rename` only moves a regular file.
 * `copyLocal` reads from `localDir` (whose real path must be inside the private root too).
 */
export function guardedFileDeps(realRoot: string, filesDir: string, localDir?: string) {
  const at = async (name: string) => {
    if (!plainName(name)) throw new Error(`bad file name: ${name}`);
    const have = await lstat(filesDir);
    if (have.isSymbolicLink() || !have.isDirectory()) throw new Error("the files folder is a symlink or not a folder");
    return join(await checkDir(realRoot, filesDir), name);
  };
  const write = async (name: string, bytes: Uint8Array) => {
    const p = await at(name);
    await rm(p, { force: true }); // a leftover temp file, or a planted symlink: the link itself is removed
    await createNew(p, bytes);
  };
  return {
    /** Only a regular file counts (a guard failure is "not there"; the write that follows then fails). */
    exists: async (name: string) => {
      const p = await at(name).catch(() => null);
      return p ? ((await lstat(p).catch(() => null))?.isFile() ?? false) : false;
    },
    write,
    rename: async (from: string, to: string) => {
      const src = await at(from);
      const dst = await at(to);
      if (!(await lstat(src)).isFile()) throw new Error(`${from} isn't a regular file`);
      await rename(src, dst);
    },
    remove: async (name: string) => rm(await at(name), { force: true }),
    copyLocal: async (path: string, tmp: string) => {
      if (!localDir) throw new Error("no local folder");
      const base = await realpath(localDir);
      if (!inside(realRoot, base)) throw new Error("the local folder isn't inside the real private/ folder");
      const src = resolve(base, path);
      if (!inside(base, src)) throw new Error("the local file isn't inside the local folder");
      await write(tmp, await readInside(base, src));
    },
  };
}
