import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_DISABLED, allowedHost, downloadAll, extOf, matchLocal, planDownloads, safeZipPath, zipEntries, zipEntryBytes,
  type AmbiguousLocal, type DownloadDeps, type DownloadTarget, type LocalFile,
} from "./download";
import { zip } from "./zip-fixture";

// Invented course files. Signed links look like the inst-fs ones (a token in the query).
const FS = "https://inst-fs-iad-prod.inscloudgate.net/files";
const files = [
  { id: 1, display_name: "Lecture 1.pdf", "content-type": "application/pdf", url: `${FS}/1?token=a` },
  { id: 2, display_name: "Lecture 1.pptx", "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", url: `${FS}/2?token=b` },
  { id: 3, display_name: "Review 1.docx", "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", url: `${FS}/3?token=c` },
  { id: 4, display_name: "banner.png", "content-type": "image/png", url: `${FS}/4` },
  { id: 5, display_name: "Policies.pdf", "content-type": "application/pdf", url: `${FS}/5?token=e` },
  { id: 6, display_name: "Week 2 transcript.vtt", "content-type": "text/vtt", url: `${FS}/6?token=f` },
];
const items = [
  { fileId: 2, name: "Lecture 1.pptx", role: "lecture", versions: [1, 2] }, // the PDF version is the one to fetch
  { fileId: 3, name: "Review 1.docx", role: "review" },
  { fileId: 4, name: "banner.png", role: "lecture" }, // no readable extension
  { fileId: 5, name: "Policies.pdf", role: "admin" }, // admin isn't downloaded
  { fileId: 6, name: "Week 2 transcript.vtt", role: "transcript" },
];

type Route = { status: number; type?: string; location?: string; body?: string; length?: string; hang?: boolean };

function fakeDeps(routes: Record<string, Route>, present: string[] = [], opts: { failRename?: boolean } = {}) {
  const written = new Map<string, Uint8Array>();
  const calls: { url: string; init: RequestInit }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: DownloadDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = routes[url] ?? { status: 404 };
      if (r.hang) {
        return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((res) => setTimeout(res, 2));
      inFlight--;
      const headers = new Headers();
      if (r.type) headers.set("content-type", r.type);
      if (r.location) headers.set("location", r.location);
      if (r.length) headers.set("content-length", r.length);
      return new Response(r.status >= 300 && r.status < 400 ? null : (r.body ?? "%PDF-1.4 fake"), { status: r.status, headers });
    },
    exists: async (f) => present.includes(f) || written.has(f),
    write: async (f, bytes) => {
      written.set(f, bytes);
    },
    rename: async (from, to) => {
      if (opts.failRename) throw new Error("disk full");
      written.set(to, written.get(from)!);
      written.delete(from);
    },
    remove: async (f) => {
      written.delete(f);
    },
  };
  return { deps, written, calls, max: () => maxInFlight };
}

describe("planDownloads", () => {
  it("fetches each kept item's chosen version, PDFs first, and skips what it can't read", () => {
    const plan = planDownloads(files, items);
    expect(plan.map((t) => [t.fileId, t.ext, t.role])).toEqual([
      [1, "pdf", "lecture"],
      [3, "docx", "review"],
      [6, "vtt", "transcript"],
    ]);
    expect(plan[0]).toMatchObject({ itemId: "file:1", name: "Lecture 1.pdf", url: `${FS}/1?token=a` });
  });

  it("extOf uses the name, then the content type", () => {
    expect(extOf("Slides.PDF", null)).toBe("pdf");
    expect(extOf("no-extension", "application/pdf")).toBe("pdf");
    expect(extOf("photo.jpg", "image/jpeg")).toBeNull();
    expect(extOf("run.sh", "text/x-sh")).toBeNull();
  });

  it("leaves out file ids that aren't positive integers (no path tricks in the file name)", () => {
    const bad = [
      { fileId: "../../../tmp/pwn" as unknown as number, name: "z.pdf", role: "lecture" },
      { fileId: 1.5, name: "y.pdf", role: "lecture" },
      { fileId: -3, name: "x.pdf", role: "lecture" },
      { fileId: 7, name: "w.pdf", role: "lecture", versions: ["../x" as unknown as number] },
    ];
    expect(planDownloads([], bad)).toEqual([]);
  });
});

describe("allowedHost", () => {
  it("allows the course's Canvas host and Canvas's file stores only", () => {
    expect(allowedHost("ufl.instructure.com")).toBe(true);
    expect(allowedHost("inst-fs-iad-prod.inscloudgate.net")).toBe(true);
    expect(allowedHost("instructure-uploads.s3.amazonaws.com")).toBe(true);
    expect(allowedHost("ufl.instructure.com.evil.example")).toBe(false);
    expect(allowedHost("evil.example")).toBe(false);
    expect(allowedHost("other.instructure.com")).toBe(false);
    expect(allowedHost("inscloudgate.net.evil.example")).toBe(false);
    expect(allowedHost("attacker.s3.amazonaws.com")).toBe(false);
  });

  it("allows only Instructure's exact S3 bucket hosts, not look-alike buckets anyone can register", () => {
    expect(allowedHost("instructure-uploads.s3.amazonaws.com")).toBe(true);
    expect(allowedHost("instructure-uploads.s3.us-east-1.amazonaws.com")).toBe(true);
    expect(allowedHost("INSTRUCTURE-UPLOADS.S3.AMAZONAWS.COM")).toBe(true);
    for (const h of [
      "instructure-uploads-attacker.s3.amazonaws.com",
      "instructure-uploadsx.s3.us-east-1.amazonaws.com",
      "instructure-uploads.s3.evil.amazonaws.com",
      "instructure-uploads.s3-website-us-east-1.amazonaws.com",
      "x.instructure-uploads.s3.amazonaws.com",
      "s3.amazonaws.com",
    ]) expect(allowedHost(h), h).toBe(false);
  });
});

/** The network download path is off by default; these tests opt in. */
const NET = { network: true } as const;

describe("downloadAll", () => {
  it("never fetches by default: missing files are recorded as \"download disabled\"; present and local files still count", async () => {
    const f = fakeDeps({ [`${FS}/1?token=a`]: { status: 200, type: "application/pdf" } }, ["6.vtt"]);
    f.deps.copyLocal = async (_path, tmp) => {
      f.written.set(tmp, new Uint8Array(3));
    };
    const local = new Map([[3, { path: "Week 1/Notes.docx", name: "Notes.docx", size: 3 }]]);
    const out = await downloadAll(planDownloads(files, items), f.deps, { local });
    expect(out.map((r) => [r.fileId, r.status, r.reason ?? null])).toEqual([[1, "failed", DOWNLOAD_DISABLED], [3, "local", null], [6, "present", null]]);
    expect(f.calls).toHaveLength(0);
  });

  it("downloads signed links with no credentials and skips files already on disk", async () => {
    const f = fakeDeps({
      [`${FS}/1?token=a`]: { status: 200, type: "application/pdf" },
      [`${FS}/3?token=c`]: { status: 200, type: "application/octet-stream" },
    }, ["6.vtt"]);
    const out = await downloadAll(planDownloads(files, items), f.deps, NET);
    expect(out.map((r) => [r.fileId, r.status, r.file])).toEqual([[1, "downloaded", "1.pdf"], [3, "downloaded", "3.docx"], [6, "present", "6.vtt"]]);
    expect([...f.written.keys()].sort()).toEqual(["1.pdf", "3.docx"]); // temp files renamed away
    for (const c of f.calls) {
      expect(c.init.credentials).toBe("omit");
      expect(c.init.headers).toBeUndefined();
    }
    expect(f.calls.some((c) => c.url.includes("/6"))).toBe(false);
  });

  it("records Canvas's unsigned link (login redirect) and expired links without retrying", async () => {
    const unsigned = [{ id: 1, display_name: "L.pdf", "content-type": "application/pdf", url: "https://ufl.instructure.com/files/1/download?download_frd=1" }];
    const f = fakeDeps({
      "https://ufl.instructure.com/files/1/download?download_frd=1": { status: 302, location: "https://ufl.instructure.com/login" },
    });
    const [r] = await downloadAll(planDownloads(unsigned, [{ fileId: 1, name: "L.pdf", role: "lecture" }]), f.deps, NET);
    expect(r).toMatchObject({ status: "failed", file: null });
    expect(r.reason).toMatch(/needs a signed URL/);
    expect(f.calls).toHaveLength(1); // the login page itself is never requested

    const g = fakeDeps({ [`${FS}/1?token=a`]: { status: 403, type: "text/plain" } });
    const [e] = await downloadAll(planDownloads(files.slice(0, 1), [{ fileId: 1, name: "Lecture 1.pdf", role: "lecture" }]), g.deps, NET);
    expect(e.reason).toMatch(/expired or not signed/);
    expect(g.calls).toHaveLength(1);
  });

  it("follows https redirects to the signed file, refuses http and HTML pages", async () => {
    const f = fakeDeps({
      [`${FS}/1?token=a`]: { status: 302, location: "https://instructure-uploads.s3.amazonaws.com/blob/1?sig=x" },
      "https://instructure-uploads.s3.amazonaws.com/blob/1?sig=x": { status: 200, type: "application/pdf" },
      [`${FS}/3?token=c`]: { status: 302, location: "http://ufl.instructure.com/plain" },
      [`${FS}/6?token=f`]: { status: 200, type: "text/html; charset=utf-8", body: "<html>login</html>" },
    });
    const out = await downloadAll(planDownloads(files, items), f.deps, NET);
    expect(out.map((r) => [r.fileId, r.status, r.reason ?? null])).toEqual([
      [1, "downloaded", null],
      [3, "failed", "not https"],
      [6, "failed", "got an HTML page instead of the file (login or expired link; re-export)"],
    ]);
    expect(f.written.has("6.vtt")).toBe(false);
  });

  it("never contacts a host outside the allowlist, first hop or redirect", async () => {
    const odd = [
      { id: 1, display_name: "a.pdf", url: "https://evil.example/a.pdf" },
      { id: 2, display_name: "b.pdf", url: "https://ufl.instructure.com/redir" },
    ];
    const f = fakeDeps({
      "https://evil.example/a.pdf": { status: 200, type: "application/pdf" },
      "https://ufl.instructure.com/redir": { status: 302, location: "https://evil.example/steal" },
      "https://evil.example/steal": { status: 200, type: "application/pdf" },
    });
    const out = await downloadAll(planDownloads(odd, [{ fileId: 1, name: "a", role: "lecture" }, { fileId: 2, name: "b", role: "lecture" }]), f.deps, NET);
    expect(out.map((r) => [r.fileId, r.status, r.reason])).toEqual([[1, "failed", "host not allowed: evil.example"], [2, "failed", "host not allowed: evil.example"]]);
    expect(f.calls.map((c) => c.url)).toEqual(["https://ufl.instructure.com/redir"]);
    expect(f.written.size).toBe(0);
  });

  it("refuses a link carrying a username or password, first hop or redirect, without fetching it", async () => {
    const odd = [
      { id: 1, display_name: "a.pdf", url: "https://u:p@ufl.instructure.com/files/1/download" },
      { id: 2, display_name: "b.pdf", url: "https://ufl.instructure.com/redir" },
    ];
    const f = fakeDeps({
      "https://u:p@ufl.instructure.com/files/1/download": { status: 200, type: "application/pdf" },
      "https://ufl.instructure.com/redir": { status: 302, location: "https://u@ufl.instructure.com/files/2/download" },
      "https://u@ufl.instructure.com/files/2/download": { status: 200, type: "application/pdf" },
    });
    const out = await downloadAll(planDownloads(odd, [{ fileId: 1, name: "a", role: "lecture" }, { fileId: 2, name: "b", role: "lecture" }]), f.deps, NET);
    expect(out.map((r) => [r.fileId, r.status, r.reason])).toEqual([[1, "failed", "link carries a username or password"], [2, "failed", "link carries a username or password"]]);
    expect(f.calls.map((c) => c.url)).toEqual(["https://ufl.instructure.com/redir"]);
    expect(f.written.size).toBe(0);
  });

  it("refuses a bad file id or extension even if handed one directly", async () => {
    const f = fakeDeps({});
    const t = { fileId: "../../x" as unknown as number, itemId: "file:x", name: "x", role: "lecture", ext: "pdf", url: `${FS}/1?token=a` } as DownloadTarget;
    const u = { ...t, fileId: 9, ext: "sh" as DownloadTarget["ext"] };
    const out = await downloadAll([t, u], f.deps, NET);
    expect(out.map((r) => r.reason)).toEqual(["bad file id or extension", "bad file id or extension"]);
    expect(f.calls).toHaveLength(0);
  });

  it("caps the size (by header and by bytes read) and times out", async () => {
    const one = (url: string) => [{ fileId: 1, itemId: "file:1", name: "L.pdf", role: "lecture", ext: "pdf" as const, url }];
    const f = fakeDeps({
      [`${FS}/big`]: { status: 200, type: "application/pdf", length: String(200 * 1024 * 1024) },
      [`${FS}/liar`]: { status: 200, type: "application/pdf", body: "x".repeat(2000) },
      [`${FS}/slow`]: { status: 200, hang: true },
    });
    const [big] = await downloadAll(one(`${FS}/big`), f.deps, NET);
    expect(big.reason).toBe("larger than 100 MB");
    const [liar] = await downloadAll(one(`${FS}/liar`), f.deps, { ...NET, maxBytes: 1000 });
    expect(liar).toMatchObject({ status: "failed", reason: "larger than 1000 bytes" });
    const [slow] = await downloadAll(one(`${FS}/slow`), f.deps, { ...NET, timeoutMs: 20 });
    expect(slow).toMatchObject({ status: "failed", reason: "timed out" });
    expect(f.written.size).toBe(0);
  });

  it("writes to a temp file and renames, so a failed save leaves nothing that counts", async () => {
    const f = fakeDeps({ [`${FS}/1?token=a`]: { status: 200, type: "application/pdf" } }, [], { failRename: true });
    const [r] = await downloadAll(planDownloads(files.slice(0, 1), [{ fileId: 1, name: "Lecture 1.pdf", role: "lecture" }]), f.deps, NET);
    expect(r).toMatchObject({ status: "failed", file: null, reason: "couldn't save: disk full" });
    expect(f.written.size).toBe(0); // the temp file was removed; 1.pdf was never created
    expect(await f.deps.exists("1.pdf")).toBe(false);
  });

  it("never runs more than 4 at once", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: 100 + i, display_name: `D${i}.pdf`, "content-type": "application/pdf", url: `${FS}/${100 + i}?t=1` }));
    const routes = Object.fromEntries(many.map((m) => [m.url, { status: 200, type: "application/pdf" }]));
    const f = fakeDeps(routes);
    const out = await downloadAll(planDownloads(many, many.map((m) => ({ fileId: m.id, name: m.display_name, role: "lecture" }))), f.deps, NET);
    expect(out.every((r) => r.status === "downloaded")).toBe(true);
    expect(f.max()).toBe(4);
  });
});

describe("local files (the student's Files-tab download)", () => {
  const t = (fileId: number, name: string, size?: number, filename?: string): DownloadTarget =>
    ({ fileId, itemId: `file:${fileId}`, name, role: "lecture", ext: "pdf", url: `${FS}/${fileId}?token=x`, size, filename });

  it("doesn't guess when the export has no size and the name appears twice: reported as ambiguous", () => {
    const local: LocalFile[] = [
      { path: "Week 1/Lecture 1.pdf", name: "Lecture 1.pdf", size: 100 },
      { path: "Old/lecture 1.pdf", name: "lecture 1.pdf", size: 90 },
      { path: "Week 2/Lecture 2.pdf", name: "Lecture 2.pdf", size: 200 },
    ];
    const ambiguous: AmbiguousLocal[] = [];
    const m = matchLocal([t(1, "Lecture 1.pdf"), t(2, "Lecture 2.pdf"), t(3, "Lecture 1.pdf", 90)], local, undefined, ambiguous);
    expect([...m].map(([id, f]) => [id, f.path])).toEqual([[2, "Week 2/Lecture 2.pdf"], [3, "Old/lecture 1.pdf"]]);
    expect(ambiguous).toEqual([{ fileId: 1, name: "Lecture 1.pdf", paths: ["Old/lecture 1.pdf", "Week 1/Lecture 1.pdf"] }]);
  });

  it("matches by display name, then Canvas's stored name, and by size when known", () => {
    const local: LocalFile[] = [
      { path: "Week 1/Lecture 1.pdf", name: "Lecture 1.pdf", size: 100 },
      { path: "Old/Lecture 2.pdf", name: "Lecture 2.pdf", size: 999 },
      { path: "Week 2/Lecture 2.pdf", name: "Lecture 2.pdf", size: 200 },
      { path: "heaps_v2.pdf", name: "heaps_v2.pdf", size: 300 },
      { path: "Huge.pdf", name: "Huge.pdf", size: 200 * 1024 * 1024 },
    ];
    const m = matchLocal([t(1, "Lecture 1.pdf"), t(2, "Lecture 2.pdf", 200), t(3, "Heaps.pdf", 300, "heaps_v2.pdf"), t(4, "Lecture 1.pdf", 555), t(5, "Huge.pdf")], local);
    expect([...m].map(([id, f]) => [id, f.path])).toEqual([[1, "Week 1/Lecture 1.pdf"], [2, "Week 2/Lecture 2.pdf"], [3, "heaps_v2.pdf"]]);
  });

  it("uses an exact-name copy whose size is a non-chosen version's, and prefers it as the item's file", () => {
    // Two uploads of one review under the same name: last year's (chosen by the import) and this term's.
    const exportFiles = [
      { id: 10, display_name: "Exam 1 Review A.pdf", filename: "Exam_1_Review_A.pdf", size: 556, url: `${FS}/10` },
      { id: 20, display_name: "Exam 1 Review A.pdf", filename: "Exam_1_Review_A-1.pdf", size: 530, url: `${FS}/20` },
      { id: 30, display_name: "Exam 2 Review A.pdf", size: 1153, url: `${FS}/30`, created_at: "2025-08-08T20:37:59Z" },
      { id: 40, display_name: "Exam 2 Review A.pdf", size: 1013, url: `${FS}/40`, created_at: "2026-10-01T16:39:45Z" },
      { id: 50, display_name: "Heaps.pdf", size: 70, url: `${FS}/50` },
      { id: 51, display_name: "Heaps_accessible.pdf", size: 71, url: `${FS}/51` },
      { id: 52, display_name: "Heaps.pptx", size: 72, url: `${FS}/52` },
    ];
    const plan = planDownloads(exportFiles, [
      { fileId: 10, name: "Exam 1 Review A.pdf", role: "review", versions: [10, 20] },
      { fileId: 30, name: "Exam 2 Review A.pdf", role: "review", versions: [30, 40] },
      { fileId: 50, name: "Heaps.pdf", role: "lecture", versions: [50, 51, 52] },
    ]);
    expect(plan.find((p) => p.fileId === 50)?.alternates?.map((a) => a.fileId)).toEqual([51]); // the .pptx isn't a PDF alternate
    const local: LocalFile[] = [
      // Exam 1: only this term's copy is on disk (its size is version 20's, not the chosen 10's).
      { path: "Reviews/Exam 1 Review A.pdf", name: "Exam 1 Review A.pdf", size: 530 },
      // Exam 2: both copies are on disk; sizes tell them apart and dates order them: the newer upload wins.
      { path: "Old/Exam 2 Review A.pdf", name: "Exam 2 Review A.pdf", size: 1153 },
      { path: "Exam 2 Review A.pdf", name: "Exam 2 Review A.pdf", size: 1013 },
      // Heaps: only the accessible version is local; it stands in for the chosen deck.
      { path: "Heaps_accessible.pdf", name: "Heaps_accessible.pdf", size: 71 },
      // Same name, but a size no version has: not this file.
      { path: "x/Heaps.pdf", name: "Heaps.pdf", size: 999 },
    ];
    const m = matchLocal(plan, local);
    expect([...m].map(([id, f]) => [id, f.path, f.version?.fileId ?? null])).toEqual([
      [10, "Reviews/Exam 1 Review A.pdf", 20],
      [30, "Exam 2 Review A.pdf", 40],
      [50, "Heaps_accessible.pdf", 51],
    ]);
  });

  it("doesn't pick between same-name copies when the export's dates or sizes can't tell them apart", () => {
    const v = (fileId: number, size?: number, createdAt?: string) => ({ fileId, name: "Review.pdf", size, createdAt });
    const target = (alts: ReturnType<typeof v>[], first: ReturnType<typeof v>): DownloadTarget => ({ ...t(first.fileId, "Review.pdf", first.size), createdAt: first.createdAt, alternates: alts });
    const local: LocalFile[] = [
      { path: "a/Review.pdf", name: "Review.pdf", size: 10 },
      { path: "b/Review.pdf", name: "Review.pdf", size: 20 },
    ];
    const ambiguous: AmbiguousLocal[] = [];
    const m = matchLocal([
      target([v(2, 20)], v(1, 10)), // no dates: can't say which is newer
      target([v(4, 10, "2026-10-01T00:00:00Z")], v(3, 10, "2025-10-01T00:00:00Z")), // same size: one local file, two versions
      target([v(6, undefined, "2026-10-01T00:00:00Z")], v(5, 20, "2025-10-01T00:00:00Z")), // a version without a size, two copies of its name
      target([v(8, 20, "2026-10-01T00:00:00Z")], v(7, 10, "2025-10-01T00:00:00Z")), // sizes and dates: the newer (8) wins
    ], local, undefined, ambiguous);
    expect([...m].map(([id, f]) => [id, f.path, f.version?.fileId ?? null])).toEqual([[7, "b/Review.pdf", 8]]);
    expect(ambiguous.map((a) => [a.fileId, a.paths])).toEqual([
      [1, ["a/Review.pdf", "b/Review.pdf"]],
      [3, ["a/Review.pdf"]],
      [5, ["a/Review.pdf", "b/Review.pdf"]],
    ]);
  });

  it("reports two local copies with the same name and size as ambiguous (content may differ), for every kind of match", () => {
    const local: LocalFile[] = [
      { path: "a/Heaps.pdf", name: "Heaps.pdf", size: 50 },
      { path: "b/Heaps.pdf", name: "Heaps.pdf", size: 50 },
      { path: "a/Graphs_v2.pdf", name: "Graphs_v2.pdf", size: 60 },
      { path: "b/Graphs_v2.pdf", name: "Graphs_v2.pdf", size: 60 },
    ];
    const ambiguous: AmbiguousLocal[] = [];
    const m = matchLocal([
      t(1, "Heaps.pdf", 50), // the chosen version, size known
      { ...t(2, "Heaps.pdf", 70), alternates: [{ fileId: 3, name: "Heaps.pdf", size: 50, createdAt: "2026-10-01T00:00:00Z" }] }, // an exact-name newer upload
      { ...t(4, "Graphs.pdf", 10), alternates: [{ fileId: 5, name: "Graphs_v2.pdf", size: 60 }] }, // another version's name
    ], local, undefined, ambiguous);
    expect([...m]).toEqual([]);
    expect(ambiguous.map((a) => [a.fileId, a.paths])).toEqual([
      [1, ["a/Heaps.pdf", "b/Heaps.pdf"]],
      [2, ["a/Heaps.pdf", "b/Heaps.pdf"]],
      [4, ["a/Graphs_v2.pdf", "b/Graphs_v2.pdf"]],
    ]);
  });

  it("saves a local copy of another version under that version's file id", async () => {
    const f = fakeDeps({});
    f.deps.copyLocal = async (_path, tmp) => {
      f.written.set(tmp, new Uint8Array(5));
    };
    const local = new Map([[10, { path: "Reviews/Exam 1 Review A.pdf", name: "Exam 1 Review A.pdf", size: 5, version: { fileId: 20, name: "Exam 1 Review A.pdf" } }]]);
    const [r] = await downloadAll([{ ...t(10, "Exam 1 Review A.pdf"), role: "review" }], f.deps, { local });
    expect(r).toMatchObject({ fileId: 20, itemId: "file:20", role: "review", status: "local", file: "20.pdf" });
    expect([...f.written.keys()]).toEqual(["20.pdf"]);
    expect(f.calls).toHaveLength(0);
  });

  it("copies a matched local file (temp then rename) before trying any URL, counted as local", async () => {
    const f = fakeDeps({});
    const copied: string[] = [];
    f.deps.copyLocal = async (path, tmp) => {
      copied.push(`${path} -> ${tmp}`);
      f.written.set(tmp, new Uint8Array(3));
    };
    const local = new Map([[1, { path: "Week 1/Lecture 1.pdf", name: "Lecture 1.pdf", size: 3 }]]);
    const [r] = await downloadAll([t(1, "Lecture 1.pdf")], f.deps, { local });
    expect(r).toMatchObject({ status: "local", file: "1.pdf", bytes: 3 });
    expect(copied).toEqual(["Week 1/Lecture 1.pdf -> 1.pdf.part"]);
    expect([...f.written.keys()]).toEqual(["1.pdf"]);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses unsafe zip paths: absolute, .., backslashes, drive letters", () => {
    expect(safeZipPath("Week 1/Lecture 1.pdf")).toBe("Week 1/Lecture 1.pdf");
    expect(safeZipPath("./a/./b.pdf")).toBe("a/b.pdf");
    for (const bad of ["/etc/passwd", "../x.pdf", "a/../../x.pdf", "a\\..\\x.pdf", "C:/x.pdf", "a//b.pdf", ""]) expect(safeZipPath(bad)).toBeNull();
  });

  it("unpacks only safe entries: no traversal, symlinks, oversized files or size lies", () => {
    const bytes = zip([
      { name: "Week 1/Lecture 1.pdf", body: "%PDF-1.4 one" },
      { name: "../escape.pdf", body: "x" },
      { name: "/abs.pdf", body: "x" },
      { name: "link.pdf", body: "/etc/passwd", mode: 0o120777 },
      { name: "big.pdf", body: "y".repeat(5000) },
      { name: "__MACOSX/._Lecture 1.pdf", body: "meta" },
      { name: "Week 1/", body: "" },
    ]);
    const { entries, refused } = zipEntries(bytes, 1000);
    expect(entries.map((e) => e.path)).toEqual(["Week 1/Lecture 1.pdf"]);
    expect(new TextDecoder().decode(zipEntryBytes(bytes, entries[0], 1000))).toBe("%PDF-1.4 one");
    expect(refused).toEqual([
      { name: "../escape.pdf", reason: "unsafe path" },
      { name: "/abs.pdf", reason: "unsafe path" },
      { name: "link.pdf", reason: "symlink" },
      { name: "big.pdf", reason: "over the size cap" },
    ]);
    // A zip bomb that declares a small size can't inflate past it.
    const bomb = zip([{ name: "bomb.pdf", body: new Uint8Array(1_000_000), declaredSize: 10 }]);
    const [e] = zipEntries(bomb).entries;
    expect(() => zipEntryBytes(bomb, e)).toThrow();
  });
});
