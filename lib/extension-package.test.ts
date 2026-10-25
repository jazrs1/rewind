// The extension download holds exactly the files Chrome loads, from the current manifest (with the site's origins),
// and never an env file, a key, a source map, a test or a README. The guards refuse such files even when referenced.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { EXTENSION_FOLDER, EXTENSION_PUBLIC_KEY, extensionFiles, extensionIdFromKey, extensionZip } from "./extension-package.ts";
import { extensionId, parseExtensionIds, PINNED_EXTENSION_ID } from "./extension.ts";
import { PRODUCTION_ORIGINS } from "./brand/site.ts";

/** Reads a zip's central directory and inflates every entry. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const local = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(local, local + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const SHIPPED = [
  "allowed-origins.js",
  "background.js",
  "bridge.js",
  "canvas/canvas-api.js",
  "canvas/content.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  // The popup's logic, its mark, and its bundled fonts (found through popup.css's url()s).
  "popup/courses.js",
  "popup/fonts/atkinson-hyperlegible-400-latin.woff2",
  "popup/fonts/atkinson-hyperlegible-700-latin.woff2",
  "popup/fonts/bricolage-grotesque-latin.woff2",
  "popup/fonts/caveat-latin.woff2",
  "popup/mark.svg",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "zoom/content.js",
  "zoom/embed.js",
  "zoom/player.js",
  "zoom/transcript.js",
];

describe("the extension download", () => {
  const files = unzip(extensionZip());

  it("holds exactly the files the manifest loads, under one folder, byte for byte", () => {
    expect([...files.keys()].sort()).toEqual(SHIPPED.map((f) => `${EXTENSION_FOLDER}/${f}`));
    for (const f of SHIPPED) expect(files.get(`${EXTENSION_FOLDER}/${f}`)!.equals(readFileSync(join("extension", f))), f).toBe(true);
  });

  it("contains no .env, keys, certificates, source maps, tests or docs", () => {
    for (const name of files.keys()) {
      expect(name).not.toMatch(/(^|\/)\.env|\.(pem|key|crx|map|md)$|(^|\/)test\/|\.test\.js$|(^|\/)\./i);
    }
    for (const [name, data] of files) {
      if (name.endsWith(".png")) continue;
      const text = data.toString("utf8");
      expect(text, name).not.toMatch(/sourceMappingURL|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAIza[0-9A-Za-z_-]{20,}|\b(sk|rk|pk)_(live|test)_|sk-ant-|ANTHROPIC_API_KEY|GEMINI_API_KEY|CLERK_SECRET|KV_REST_API_TOKEN/);
    }
  });

  it("is built from the current manifest: the site's origins, and the pinned public key", () => {
    const manifest = JSON.parse(files.get(`${EXTENSION_FOLDER}/manifest.json`)!.toString("utf8"));
    expect(manifest.key).toBe(EXTENSION_PUBLIC_KEY);
    for (const o of PRODUCTION_ORIGINS) expect(manifest.externally_connectable.matches).toContain(`${o}/*`);
    const origins = files.get(`${EXTENSION_FOLDER}/allowed-origins.js`)!.toString("utf8");
    for (const o of PRODUCTION_ORIGINS) expect(origins).toContain(`'${o}'`);
  });

  it("is the same bytes every build", () => {
    expect(extensionZip().equals(extensionZip())).toBe(true);
  });

  it("its route is never ignored by git (.gitignore has *.zip, and the route's folder is named like a zip)", () => {
    const route = "app/extension/rewind-extension.zip/route.ts";
    // check-ignore exits 1 when nothing ignores the path.
    let ignored = true;
    try {
      execFileSync("git", ["check-ignore", "-q", route]);
    } catch {
      ignored = false;
    }
    expect(ignored, `${route} is ignored, so it would never be committed`).toBe(false);
  });

  it("is served by /extension/rewind-extension.zip as a download", async () => {
    const { GET } = await import("../app/extension/rewind-extension.zip/route.ts");
    const res = await GET();
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="rewind-extension.zip"');
    expect(Buffer.from(await res.arrayBuffer()).equals(extensionZip())).toBe(true);
  });
});

describe("the guards", () => {
  /** A throwaway extension folder: these files, with this manifest (and the pinned key unless it says otherwise). */
  function fixture(manifest: object, extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), "rewind-ext-"));
    const write = (p: string, s: string) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), s);
    };
    write("manifest.json", JSON.stringify({ key: EXTENSION_PUBLIC_KEY, ...manifest }));
    for (const [p, s] of Object.entries(extra)) write(p, s);
    return root;
  }

  it("refuses a referenced env file, key, source map or test", () => {
    for (const bad of [".env.local", "keys/private.pem", "bg.js.map", "test/helper.js", "bg.test.js"]) {
      const root = fixture({ background: { service_worker: "bg.js" } }, { "bg.js": `importScripts('${bad}');`, [bad]: "x" });
      expect(() => extensionFiles(root), bad).toThrow(/must not be in the extension download/);
    }
  });

  it("refuses a file holding a source map link or a secret", () => {
    for (const text of ["//# sourceMappingURL=bg.js.map", "const k = 'sk-ant-api03-abc';", "-----BEGIN PRIVATE KEY-----"]) {
      const root = fixture({ background: { service_worker: "bg.js" } }, { "bg.js": text });
      expect(() => extensionFiles(root), text).toThrow(/secret or a source map/);
    }
  });

  it("refuses a manifest pinning another extension id (or none), and paths outside the folder", () => {
    expect(() => extensionFiles(fixture({ key: "MIIB..." }))).toThrow(/pinned public key/);
    expect(() => extensionFiles(fixture({ key: undefined }))).toThrow(/pinned public key/);
    expect(() => extensionFiles(fixture({ background: { service_worker: "../outside.js" } }))).toThrow(/outside the extension/);
  });

  it("leaves out files nothing loads (an unreferenced .env is never picked up)", () => {
    const root = fixture({ background: { service_worker: "bg.js" } }, { "bg.js": "1;", ".env": "SECRET=1", "README.md": "#" });
    expect(extensionFiles(root).map((f) => f.path)).toEqual(["bg.js", "manifest.json"]);
  });
});

describe("the pinned extension ID (every unpacked install of the zip gets the same one)", () => {
  it("the built manifest's key produces the expected ID, the one the site talks to by default", () => {
    const manifest = JSON.parse(extensionFiles().find((f) => f.path.endsWith("manifest.json"))!.data.toString("utf8"));
    expect(extensionIdFromKey(manifest.key)).toBe("obplkjkoolikmejjcmkbbmcjhpcpbppp");
    expect(PINNED_EXTENSION_ID).toBe("obplkjkoolikmejjcmkbbmcjhpcpbppp");
    expect(extensionIdFromKey(EXTENSION_PUBLIC_KEY)).toBe(PINNED_EXTENSION_ID);
  });

  it("derives IDs the way Chrome does (a vector computed independently, in Python)", () => {
    expect(extensionIdFromKey("cmV3aW5kLXRlc3QtdmVjdG9y")).toBe("neonofeeopbkmlefknbaeidehlnfkgfo");
  });

  it("the key is a public key only: no private key in the manifest or this repo's extension code", () => {
    expect(Buffer.from(EXTENSION_PUBLIC_KEY, "base64").subarray(0, 2).toString("hex")).toBe("3082");
    // An RSA public key (SPKI) is about 294 bytes; a 2048-bit private key is over 1,200. No PEM private key block anywhere.
    expect(Buffer.from(EXTENSION_PUBLIC_KEY, "base64").length).toBeLessThan(400);
    const pemBlock = /-----BEGIN (RSA )?PRIVATE KEY-----\s*[A-Za-z0-9+/]{40}/;
    for (const f of extensionFiles()) expect(f.data.toString("utf8"), f.path).not.toMatch(pemBlock);
    expect(readFileSync("lib/extension-package.ts", "utf8")).not.toMatch(pemBlock);
  });

  it("refuses a manifest whose key isn't the pinned one, or that has none", () => {
    const root = mkdtempSync(join(tmpdir(), "rewind-ext-key-"));
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
    for (const key of [undefined, "cmV3aW5kLXRlc3QtdmVjdG9y"]) {
      writeFileSync(join(root, "manifest.json"), JSON.stringify({ ...manifest, key, content_scripts: [], background: undefined, action: undefined, icons: undefined }));
      expect(() => extensionFiles(root)).toThrow(/pinned public key/);
    }
  });
});

describe("the IDs the site talks to (NEXT_PUBLIC_REWIND_EXTENSION_IDS)", () => {
  it("unset: the pinned one (after the older single variable, if that is set)", () => {
    expect(parseExtensionIds(undefined, undefined)).toEqual([PINNED_EXTENSION_ID]);
    expect(parseExtensionIds("", "")).toEqual([PINNED_EXTENSION_ID]);
    expect(parseExtensionIds(undefined, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", PINNED_EXTENSION_ID]);
  });

  it("a comma-separated list, in order, valid IDs only, no repeats (a store ID can be added without code changes)", () => {
    const store = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(parseExtensionIds(` ${PINNED_EXTENSION_ID}, ${store} ,not-an-id,${store}`, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual([PINNED_EXTENSION_ID, store]);
  });

  it("this test environment talks to the pinned one by default", () => {
    expect(extensionId().split(",")).toContain(PINNED_EXTENSION_ID);
  });
});


describe("the /extension zip, unpacked anywhere, has the site's ID", () => {
  it("unpacked into two different folders: both manifests derive the same, expected ID", () => {
    const files = unzip(extensionZip());
    const ids = ["first place", "somewhere/else entirely"].map((where) => {
      const root = join(mkdtempSync(join(tmpdir(), "rewind-unpack-")), where);
      for (const [name, data] of files) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), data);
      }
      const manifest = JSON.parse(readFileSync(join(root, EXTENSION_FOLDER, "manifest.json"), "utf8"));
      return extensionIdFromKey(manifest.key);
    });
    expect(ids).toEqual([PINNED_EXTENSION_ID, PINNED_EXTENSION_ID]);
  });

  it("the site's ID, with nothing set in the environment (as on Vercel Production today), is the one the manifest key derives", () => {
    vi.stubEnv("NEXT_PUBLIC_REWIND_EXTENSION_IDS", "");
    vi.stubEnv("NEXT_PUBLIC_REWIND_EXTENSION_ID", "");
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_ID", "");
    try {
      const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
      expect(extensionId()).toBe(extensionIdFromKey(manifest.key));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
