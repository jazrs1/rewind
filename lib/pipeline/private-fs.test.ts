import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadAll, type DownloadTarget } from "./download";
import { ensureDirInside, guardedFileDeps, pinnedPrivateRoot, realPrivateRoot, writeInside } from "./private-fs";
import { unpackZip } from "./unzip";
import { zip } from "./zip-fixture";

// Invented files only. <tmp>/real-private is the real private dir, <tmp>/outside anywhere else.
let tmp: string;
let realPrivate: string;
let outside: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "rewind-privfs-")));
  realPrivate = join(tmp, "real-private");
  outside = join(tmp, "outside");
  await mkdir(join(realPrivate, "files", "X"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "victim"), "untouched");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });

describe("pinnedPrivateRoot", () => {
  it("is the main checkout's real private/ from a worker worktree; the worktree's private/ link to it is allowed, a link elsewhere is refused", async () => {
    const main = join(tmp, "main");
    await mkdir(join(main, "private", "files", "X"), { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", join(tmp, "wt"));
    git(main, "worktree", "add", "-q", join(tmp, "wt2"));
    await symlink(join(main, "private"), join(tmp, "wt", "private"));
    await mkdir(join(outside, "fakepriv", "files", "X"), { recursive: true });
    await symlink(join(outside, "fakepriv"), join(tmp, "wt2", "private"));

    const pinned = await pinnedPrivateRoot({ env: {}, cwd: join(tmp, "wt") });
    expect(pinned).toBe(join(main, "private"));
    expect(await pinnedPrivateRoot({ env: {}, cwd: main })).toBe(pinned);
    expect(await pinnedPrivateRoot({ env: {}, cwd: join(tmp, "wt2") })).toBe(pinned);

    // The worktree's intentional link works end to end.
    const okLocal = join(tmp, "wt", "private", "files", "X");
    await writeFile(join(okLocal, "f.zip"), zip([{ name: "a.pdf", body: "%PDF a" }]));
    expect(await unpackZip(join(okLocal, "f.zip"), join(okLocal, "f.unzipped"), join(tmp, "wt", "private"), { pinnedRoot: pinned })).toMatchObject({ written: 1 });
    expect(await readFile(join(main, "private", "files", "X", "f.unzipped", "a.pdf"), "utf8")).toBe("%PDF a");

    // A worktree whose private/ leads anywhere else is refused.
    await expect(realPrivateRoot(join(tmp, "wt2", "private"), pinned)).rejects.toThrow(/real private folder/);
    const badLocal = join(tmp, "wt2", "private", "files", "X");
    await writeFile(join(badLocal, "f.zip"), zip([{ name: "a.pdf", body: "%PDF a" }]));
    await expect(unpackZip(join(badLocal, "f.zip"), join(badLocal, "f.unzipped"), join(tmp, "wt2", "private"), { pinnedRoot: pinned })).rejects.toThrow(/real private folder/);
    expect(await readdir(join(outside, "fakepriv", "files", "X"))).toEqual(["f.zip"]);
  });

  it("uses REWIND_PRIVATE_ROOT when set (resolved to its real path)", async () => {
    await symlink(realPrivate, join(tmp, "link"));
    expect(await pinnedPrivateRoot({ env: { REWIND_PRIVATE_ROOT: join(tmp, "link") } })).toBe(realPrivate);
    await expect(pinnedPrivateRoot({ env: { REWIND_PRIVATE_ROOT: join(tmp, "missing") } })).rejects.toThrow(/doesn't exist/);
  });
});

describe("ensureDirInside", () => {
  it("makes the folders one by one and refuses a symlinked target folder", async () => {
    expect(await ensureDirInside(realPrivate, ["pipeline", "C", "files"])).toBe(join(realPrivate, "pipeline", "C", "files"));
    await mkdir(join(realPrivate, "pipeline", "D"), { recursive: true });
    await symlink(outside, join(realPrivate, "pipeline", "D", "files"));
    await expect(ensureDirInside(realPrivate, ["pipeline", "D", "files"])).rejects.toThrow(/symlink/);
    // Even a link that stays inside private/ is refused.
    await symlink(join(realPrivate, "files"), join(realPrivate, "pipeline", "E"));
    await expect(ensureDirInside(realPrivate, ["pipeline", "E", "files"])).rejects.toThrow(/symlink/);
    await expect(ensureDirInside(realPrivate, ["pipeline", ".."])).rejects.toThrow(/bad folder name/);
  });
});

describe("guardedFileDeps (front-half's download writes)", () => {
  const target = (fileId: number): DownloadTarget => ({ fileId, itemId: `file:${fileId}`, name: `L${fileId}.pdf`, role: "lecture", ext: "pdf", url: `https://ufl.instructure.com/files/${fileId}?verifier=x` });
  const fetchPdf = async () => new Response("%PDF net", { status: 200, headers: { "content-type": "application/pdf" } });

  it("never writes through a planted .part symlink (network and local copy)", async () => {
    const files = await ensureDirInside(realPrivate, ["pipeline", "C", "files"]);
    const local = join(realPrivate, "files", "C");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, "L2.pdf"), "%PDF local");
    await symlink(join(outside, "victim"), join(files, "1.pdf.part"));
    await symlink(join(outside, "victim"), join(files, "2.pdf.part"));
    const deps = { fetch: fetchPdf, ...guardedFileDeps(realPrivate, files, local) };
    const out = await downloadAll([target(1), target(2)], deps, { network: true, local: new Map([[2, { path: "L2.pdf", name: "L2.pdf", size: 10 }]]) });
    expect(out.map((r) => r.status)).toEqual(["downloaded", "local"]);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("untouched");
    expect(await readFile(join(files, "1.pdf"), "utf8")).toBe("%PDF net");
    expect(await readFile(join(files, "2.pdf"), "utf8")).toBe("%PDF local");
    expect((await readdir(files)).sort()).toEqual(["1.pdf", "2.pdf"]);
  });

  it("refuses to write when the files folder has been swapped for a symlink", async () => {
    const files = await ensureDirInside(realPrivate, ["pipeline", "C", "files"]);
    await rm(files, { recursive: true });
    await symlink(outside, files);
    const deps = { fetch: fetchPdf, ...guardedFileDeps(realPrivate, files) };
    const [r] = await downloadAll([target(1)], deps, { network: true });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/couldn't save/) });
    expect(await readdir(outside)).toEqual(["victim"]);
  });

  it("refuses a files folder outside the real private root, and a local copy that leaves the local folder", async () => {
    const deps = guardedFileDeps(realPrivate, outside, outside);
    await expect(deps.write("1.pdf.part", new Uint8Array([1]))).rejects.toThrow(/isn't inside the real private/);
    const files = await ensureDirInside(realPrivate, ["pipeline", "C", "files"]);
    const local = join(realPrivate, "files", "C");
    await mkdir(local, { recursive: true });
    await symlink(join(outside, "victim"), join(local, "link.pdf"));
    const inPrivate = guardedFileDeps(realPrivate, files, local);
    await expect(inPrivate.copyLocal("link.pdf", "1.pdf.part")).rejects.toThrow();
    await expect(inPrivate.copyLocal("../../../outside/victim", "1.pdf.part")).rejects.toThrow(/isn't inside/);
    await expect(inPrivate.write("../x", new Uint8Array([1]))).rejects.toThrow(/bad file name/);
    expect(await inPrivate.exists("1.pdf.part")).toBe(false);
  });
});

describe("writeInside", () => {
  it("replaces only a regular file, never a symlink, and stays inside private/", async () => {
    const dir = await ensureDirInside(realPrivate, ["pipeline", "C"]);
    await writeInside(realPrivate, dir, "a.json", "1", { replace: true });
    await writeInside(realPrivate, dir, "a.json", "2", { replace: true });
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("2");
    await expect(writeInside(realPrivate, dir, "a.json", "3")).rejects.toThrow(/already there/);
    await symlink(join(outside, "victim"), join(dir, "b.json"));
    await expect(writeInside(realPrivate, dir, "b.json", "x", { replace: true })).rejects.toThrow(/already there/);
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("untouched");
    await expect(writeInside(realPrivate, outside, "c.json", "x")).rejects.toThrow(/isn't inside the real private/);
    expect((await readdir(dir)).sort()).toEqual(["a.json", "b.json"]);
  });
});
