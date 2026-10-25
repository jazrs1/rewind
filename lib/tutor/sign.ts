// What the server can vouch for in a tutor conversation. The page is rendered on the server, so it can hand the
// browser two things the browser can't forge:
//   - a session token (a nonce, so hints are counted per page visit);
//   - a signature on every tutor reply, so a "tutor" turn in the history that the server didn't write is only
//     ever treated as student text.
// Whether work is graded is NOT in a token: the server decides it per question (lib/tutor/graded.ts).
// Both are HMACs. The dev route signs under a secret made when the server starts (kept on globalThis so the page
// and the API route, which Next may bundle separately, share it). The public demo route, which runs on several
// serverless instances, builds its own signer from a secret derived from its API key (lib/demo/tutor-route.ts).
// Nothing is stored: an invalid or missing token means graded (dev) or no hint credit (demo).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface Signer {
  sign(s: string): string;
  verify(s: string, sig: unknown): boolean;
  /** The signature a tutor reply carries: bound to the question and its kind, so it can't be moved to another turn. */
  replySig(questionId: string, kind: string, text: string): string;
  replyOk(questionId: string, kind: string, text: string, sig: unknown): boolean;
}

export function makeSigner(getSecret: () => Buffer | string): Signer {
  const sign = (s: string) => createHmac("sha256", getSecret()).update(s).digest("base64url");
  const verify = (s: string, sig: unknown) => {
    if (typeof sig !== "string") return false;
    const a = Buffer.from(sign(s));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  return {
    sign,
    verify,
    replySig: (q, kind, text) => sign(`reply|${q}|${kind}|${text}`),
    replyOk: (q, kind, text, sig) => verify(`reply|${q}|${kind}|${text}`, sig),
  };
}

const KEY = Symbol.for("rewind.tutor.secret");
const secret = (): Buffer => {
  const g = globalThis as unknown as Record<symbol, Buffer | undefined>;
  return (g[KEY] ??= randomBytes(32));
};

const processSigner = makeSigner(secret);
export const { sign, verify, replySig, replyOk } = processSigner;

export interface Session {
  /** Per page load, so hints are counted per visit and question. */
  nonce: string;
}

/** A token for a page the server just rendered. */
export function issueSession(): string {
  const body = `p|${randomBytes(9).toString("base64url")}`;
  return `${body}|${sign(`session|${body}`)}`;
}

/** The session a token vouches for, or null when it is missing, altered or from before a restart. */
export function readSession(token: unknown): Session | null {
  if (typeof token !== "string") return null;
  const i = token.lastIndexOf("|");
  if (i < 0) return null;
  const body = token.slice(0, i);
  if (!verify(`session|${body}`, token.slice(i + 1))) return null;
  const [kind, nonce] = body.split("|");
  return kind === "p" && nonce ? { nonce } : null;
}
