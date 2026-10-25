// Who is signed in, for the account routes. The user id comes only from the verified server session
// (Clerk's `auth()`), never from a request body or query.
//
// Fake sign-in, for tests only: with REWIND_FAKE_AUTH=1 outside production, the id is read from the
// `rewind-fake-user` cookie that the test sign-in form sets. A production build (`next build` /
// `next start` run with NODE_ENV=production) or any Vercel deploy can never turn it on.

import { FAKE_COOKIE, FAKE_ID, fakeAuthEnabled } from "./fake.ts";

export { fakeAuthEnabled };

type Env = Record<string, string | undefined>;

export interface AuthSources {
  /** The fake cookie's value, if any. */
  fakeCookie: () => Promise<string | undefined>;
  /** Clerk's verified user id, or null when signed out. */
  clerk: () => Promise<string | null>;
}

export async function resolveUserId(sources: AuthSources, env: Env = process.env): Promise<string | null> {
  if (fakeAuthEnabled(env)) {
    const id = await sources.fakeCookie();
    return id && FAKE_ID.test(id) ? id : null;
  }
  return sources.clerk();
}

/** The signed-in user's id for this request, or null. Loads Clerk only when it is the one in use. */
export async function getUserId(): Promise<string | null> {
  return resolveUserId({
    fakeCookie: async () => {
      const { cookies } = await import("next/headers");
      return (await cookies()).get(FAKE_COOKIE)?.value;
    },
    clerk: async () => {
      const { auth } = await import("@clerk/nextjs/server");
      return (await auth()).userId;
    },
  });
}
