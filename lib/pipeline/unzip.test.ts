import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unpackZip } from "./unzip";
import { zip } from "./zip-fixture";

// Invented files only. Layout per test: <tmp>/real-private (the real private dir),
// <tmp>/worktree/private -> real-private (a worker worktree's symlink), <tmp>/outside.
let tmp: string;
let realPrivate: string;
let outside: string;
const savedRoot = process.env.REWIND_PRIVATE_ROOT;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "rewind-unzip-")));
  realPrivate = join(tmp, "real-private");
  outside = join(tmp, "outside");
  await mkdir(join(realPrivate, "files", "X"), { recursive: true });
  await mkdir(outside);
  // The pinned real private root (lib/pipeline/private-fs pinnedPrivateRoot).
  process.env.REWIND_PRIVATE_ROOT = realPrivate;
});
afterEach(async () => {
  if (savedRoot === undefined) delete process.env.REWIND_PRIVATE_ROOT;
  else process.env.REWIND_PRIVATE_ROOT = savedRoot;
  await rm(tmp, { recursive: true, force: true });
});

async function writeZip(dir: string, entries: Parameters<typeof zip>[0]): Promise<string> {
  const p = join(dir, "files.zip");
  await writeFile(p, zip(entries));
  return p;
}

describe("unpackZip", () => {
  it("allows a private/ that is itself a symlink to the real private dir", async () => {
    await mkdir(join(tmp, "worktree"));
    await symlink(realPrivate, join(tmp, "worktree", "private"));
    const privateRoot = join(tmp, "worktree", "private");
    const local = join(privateRoot, "files", "X");
    const z = await writeZip(local, [{ name: "Week 1/Lecture 1.pdf", body: "%PDF-1.4 one" }]);
    const r = await unpackZip(z, join(local, "files.unzipped"), privateRoot);
    expect(r).toMatchObject({ written: 1, refused: [] });
    expect(await readFile(join(realPrivate, "files", "X", "files.unzipped", "Week 1", "Lecture 1.pdf"), "utf8")).toBe("%PDF-1.4 one");
    // A second run keeps what's there.
    expect(await unpackZip(z, join(local, "files.unzipped"), privateRoot)).toMatchObject({ written: 0, kept: 1 });
  });

  it("refuses a symlinked folder inside the unzip area that points outside; nothing is written there", async () => {
    const local = join(realPrivate, "files", "X");
    const dest = join(local, "files.unzipped");
    await mkdir(dest);
    await symlink(outside, join(dest, "Week 1"));
    const z = await writeZip(local, [{ name: "Week 1/Lecture 1.pdf", body: "%PDF-1.4 one" }, { name: "Week 1/Sub/x.pdf", body: "%PDF x" }, { name: "Week 2/ok.pdf", body: "%PDF ok" }]);
    const r = await unpackZip(z, dest, realPrivate);
    expect(r.written).toBe(1);
    expect(r.refused.map((x) => x.name)).toEqual(["Week 1/Lecture 1.pdf", "Week 1/Sub/x.pdf"]);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses an unzip folder that is a symlink out of the real private dir", async () => {
    const local = join(realPrivate, "files", "X");
    await symlink(outside, join(local, "files.unzipped"));
    const z = await writeZip(local, [{ name: "a.pdf", body: "%PDF a" }]);
    await expect(unpackZip(z, join(local, "files.unzipped"), realPrivate)).rejects.toThrow(/isn't inside the real private/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("never writes through a planted .part symlink", async () => {
    const local = join(realPrivate, "files", "X");
    const dest = join(local, "files.unzipped");
    await mkdir(dest);
    await writeFile(join(outside, "target"), "untouched");
    await symlink(join(outside, "target"), join(dest, "a.pdf.part"));
    const z = await writeZip(local, [{ name: "a.pdf", body: "%PDF a" }]);
    expect(await unpackZip(z, dest, realPrivate)).toMatchObject({ written: 1 });
    expect(await readFile(join(outside, "target"), "utf8")).toBe("untouched");
    expect(await readFile(join(dest, "a.pdf"), "utf8")).toBe("%PDF a");
  });

  it("keeps both of two names that differ only in case, the later one with a suffix", async () => {
    const local = join(realPrivate, "files", "X");
    const z = await writeZip(local, [{ name: "Notes.pdf", body: "%PDF upper" }, { name: "notes.pdf", body: "%PDF lower!" }]);
    const dest = join(local, "files.unzipped");
    const r = await unpackZip(z, dest, realPrivate);
    expect(r).toMatchObject({ written: 2, renamed: [{ from: "notes.pdf", to: "notes (2).pdf" }] });
    expect(await readFile(join(dest, "Notes.pdf"), "utf8")).toBe("%PDF upper");
    expect(await readFile(join(dest, "notes (2).pdf"), "utf8")).toBe("%PDF lower!");
  });

  it("reports a zip too large to read (over 2 GB) instead of reading it", async () => {
    const local = join(realPrivate, "files", "X");
    const z = await writeZip(local, [{ name: "a.pdf", body: "%PDF a" }]);
    const r = await unpackZip(z, join(local, "files.unzipped"), realPrivate, { maxRead: 10 });
    expect(r).toMatchObject({ written: 0, refused: [{ name: "files.zip", reason: expect.stringMatching(/over 2 GB/) }] });
    expect(existsSync(join(local, "files.unzipped"))).toBe(false);
  });

  it("refuses a private/ link that leads to a folder outside the pinned real private root", async () => {
    // A worktree whose private/ points at some other folder: before, any link target was accepted.
    const fake = join(outside, "fakepriv");
    await mkdir(join(fake, "files", "X"), { recursive: true });
    await mkdir(join(tmp, "wt2"));
    await symlink(fake, join(tmp, "wt2", "private"));
    const privateRoot = join(tmp, "wt2", "private");
    const local = join(privateRoot, "files", "X");
    const z = await writeZip(local, [{ name: "x.pdf", body: "%PDF x" }]);
    await expect(unpackZip(z, join(local, "files.unzipped"), privateRoot)).rejects.toThrow(/real private folder/);
    expect(await readdir(join(fake, "files", "X"))).toEqual(["files.zip"]);
  });

  it("keeps an entry named a.pdf.part when a.pdf follows it (the temp name can't collide)", async () => {
    const local = join(realPrivate, "files", "X");
    const dest = join(local, "files.unzipped");
    const z = await writeZip(local, [{ name: "a.pdf.part", body: "P" }, { name: "a.pdf", body: "QQ" }]);
    expect(await unpackZip(z, dest, realPrivate)).toMatchObject({ written: 2, refused: [] });
    expect((await readdir(dest)).sort()).toEqual(["a.pdf", "a.pdf.part"]);
    expect(await readFile(join(dest, "a.pdf.part"), "utf8")).toBe("P");
  });

  it("skips an entry with a path segment over 255 bytes and keeps going", async () => {
    const local = join(realPrivate, "files", "X");
    const dest = join(local, "files.unzipped");
    const long = "x".repeat(300);
    const z = await writeZip(local, [{ name: `${long}/a.pdf`, body: "Q" }, { name: `${"y".repeat(256)}.pdf`, body: "Y" }, { name: "after.pdf", body: "R" }]);
    const r = await unpackZip(z, dest, realPrivate);
    expect(r.written).toBe(1);
    expect(r.refused.map((x) => [x.name.slice(0, 3), x.reason])).toEqual([["xxx", expect.stringMatching(/255/)], ["yyy", expect.stringMatching(/255/)]]);
    expect(await readdir(dest)).toEqual(["after.pdf"]);
  });
});
