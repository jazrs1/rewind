// Accounts Lite is behind one flag, off by default: NEXT_PUBLIC_REWIND_ACCOUNTS=1 turns it on. Off,
// the app is exactly the device-only app: no sign-in UI, no account requests, no account packages
// loaded in the browser (components/accounts/AccountEntry.tsx imports them only when this is on).

type Env = Record<string, string | undefined>;

export function accountsEnabled(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_REWIND_ACCOUNTS === "1";
}

/** The same rule, written out so Next inlines it into the client bundle at build time. */
export const ACCOUNTS_ON = process.env.NEXT_PUBLIC_REWIND_ACCOUNTS === "1";

/** "Import your own course (beta)": the extension's page (the README it used to point to is in a private repo). Here
 *  (not in the account menu) so the landing page can link it without loading any account code. */
export const IMPORT_DOCS = "/extension";
/** The link's full name (its title and accessible name); the short form is what's shown. */
export const IMPORT_FULL = "Import your own course: runs on your computer for now (beta)";
