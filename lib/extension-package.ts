// The downloadable extension (app/extension/rewind-extension.zip): a zip of exactly the files Chrome loads from
// extension/manifest.json, found by following the manifest (background worker, content scripts, icons, popup) and
// what those files load (importScripts, the popup's src and href). Tests, READMEs and anything else in the folder
// are never in it, and a file that looks like a secret, a source map or a test makes the build fail.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface PackagedFile {
  path: string;
  data: Buffer;
}

interface Manifest {
  icons?: Record<string, string>;
  background?: { service_worker?: string };
  action?: { default_icon?: Record<string, string>; default_popup?: string };
  content_scripts?: { js?: string[]; css?: string[] }[];
  key?: unknown;
}

/**
 * The zip's public key (manifest.json "key"): every unpacked install gets the same ID from it, PINNED_EXTENSION_ID in
 * lib/extension.ts, so rewindit.org can reach it. Only the PUBLIC key is here; the private key is kept outside the
 * repo (see docs/brand/store-listing.md) and is never committed.
 */
export const EXTENSION_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArGS2Z90jqw02e6YFJDmBa7KN3pJ69pkhbaoy6IXefkuKlTe+CnkEbI/ayjv6+qD9fzwRe8v9zIIIejouHR9AgX0AZlBfHwxHDuwMqXodu1KPKf3q3rsywD3uqlPV3aMHtuPmLVL2tn4rq/TucSmOh+0B9IVt08Ax+/iZp+5QJ3lD+7m6TtxyjOHCc2vtoWtef7gJAzcBk7m9h+8ArNj0JTnvkufkaH/hh2xjwRKM9eRMoIK3eRDbJ9jh2uhxdIS83qgc7TgGunmK6ZY9PFtqpPOl/gKtVeezc++ehNvK1VPC+xI5RmWMwxHf9sDp+9Wd+xgLElWFX89a9hEyR5R7CQIDAQAB";

/** Chrome's extension ID for a manifest key: SHA-256 of the key's bytes, first 16 bytes, each hex digit 0-f as a-p. */
export function extensionIdFromKey(base64Key: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest().subarray(0, 16).toString("hex");
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** Never shipped, whatever references it: env files, keys and certificates, source maps, tests, docs. */
const FORBIDDEN = [/(^|\/)\.env/i, /\.(pem|key|crx|map)$/i, /(^|\/)test\//i, /\.test\.js$/i, /\.md$/i, /(^|\/)\./];
/** Never inside a shipped file: a source map link, a private key, an API key or a Clerk/Stripe-style secret. */
const FORBIDDEN_TEXT = [/sourceMappingURL/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAIza[0-9A-Za-z_-]{20,}/, /\b(sk|rk)_(live|test)_[0-9A-Za-z]{8,}/, /\bsk-ant-/];

/** The files the extension loads, from its manifest outwards, with the manifest itself. */
export function extensionFiles(root = "extension"): PackagedFile[] {
  const read = (p: string) => readFileSync(posix.join(root, p));
  const manifestText = read("manifest.json").toString("utf8");
  const manifest = JSON.parse(manifestText) as Manifest;
  // The key pins the extension's ID; only the one public key whose ID the site knows may be there.
  if (manifest.key !== EXTENSION_PUBLIC_KEY) throw new Error("manifest.json's key is missing or not the pinned public key: the site couldn't reach unpacked installs");
  const paths = new Set<string>(["manifest.json"]);
  const add = (p: string | undefined, from = "") => {
    if (!p) return;
    const resolved = posix.normalize(posix.join(posix.dirname(from), p));
    if (resolved.startsWith("..") || posix.isAbsolute(resolved)) throw new Error(`${p} is outside the extension`);
    paths.add(resolved);
  };
  Object.values(manifest.icons ?? {}).forEach((p) => add(p));
  Object.values(manifest.action?.default_icon ?? {}).forEach((p) => add(p));
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  for (const cs of manifest.content_scripts ?? []) [...(cs.js ?? []), ...(cs.css ?? [])].forEach((p) => add(p));
  // What the loaded files load: the worker's importScripts, the popup's scripts, styles and images, and what its
  // styles load (url(): the popup's fonts). A file found here is scanned too, so a stylesheet's fonts come along.
  for (let i = 0, list = [...paths]; i < list.length; i++, list = [...paths]) {
    const p = list[i];
    const text = /\.(js|html|css)$/.test(p) ? read(p).toString("utf8") : "";
    for (const m of text.matchAll(/importScripts\(([^)]*)\)/g)) for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) add(s[1], p);
    for (const m of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) if (!/^[a-z]+:/i.test(m[1])) add(m[1], p);
    if (p.endsWith(".css")) for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (!/^[a-z]+:/i.test(m[1]) && !m[1].startsWith("#")) add(m[1], p);
  }
  return [...paths].sort().map((path) => {
    if (FORBIDDEN.some((r) => r.test(path))) throw new Error(`${path} must not be in the extension download`);
    const data = read(path);
    if (/\.(js|json|html|css)$/.test(path)) {
      const text = data.toString("utf8");
      const hit = FORBIDDEN_TEXT.find((r) => r.test(text));
      if (hit) throw new Error(`${path} looks like it holds a secret or a source map (${hit})`);
    }
    return { path, data };
  });
}

/** A standard zip (deflate), with a fixed timestamp so the same files always give the same bytes. */
export function zip(files: PackagedFile[]): Buffer {
  // 2026-01-01 00:00 in DOS time.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const body = deflateRawSync(f.data, { level: 9 });
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + body.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** The download's file name. */
export const EXTENSION_ZIP = "rewind-extension.zip";
/** The folder the zip unpacks to: the one to choose in chrome://extensions → Load unpacked. */
export const EXTENSION_FOLDER = "rewind-extension";

/** The download: the extension's files under one folder. */
export function extensionZip(root = "extension"): Buffer {
  return zip(extensionFiles(root).map((f) => ({ ...f, path: `${EXTENSION_FOLDER}/${f.path}` })));
}
