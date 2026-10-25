// Fake sign-in, for tests only (lib/accounts/auth.ts): REWIND_FAKE_AUTH=1, and never in production or
// on Vercel. The test sign-in form sets a cookie with an id made from the email typed; nothing is checked.
// Kept apart from auth.ts so the browser can import the cookie rules without any server code.

type Env = Record<string, string | undefined>;

export const FAKE_COOKIE = "rewind-fake-user";
export const FAKE_ID = /^fake_[a-z0-9]{1,40}$/;

export function fakeAuthEnabled(env: Env = process.env): boolean {
  return env.REWIND_FAKE_AUTH === "1" && env.NODE_ENV !== "production" && !env.VERCEL;
}

/** The same email always gives the same fake user id. */
export function fakeUserId(email: string): string {
  let h = 0x811c9dc5;
  for (const ch of email.trim().toLowerCase()) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return `fake_${h.toString(36)}`;
}
