// Quick build (beta) is behind one flag, off by default: NEXT_PUBLIC_REWIND_QUICK_BUILD=1 turns it on. Off, the route
// is 404, /quick/practice is not found, and /extension shows nothing new.

type Env = Record<string, string | undefined>;

/** Server-side, reading the environment each time (tests set it). */
export function quickBuildOn(env: Env = process.env): boolean {
  return env.NEXT_PUBLIC_REWIND_QUICK_BUILD === "1";
}

/** Client-side: Next inlines NEXT_PUBLIC_ values at build, so this literal read is the one the browser sees. */
export const QUICK_ON = process.env.NEXT_PUBLIC_REWIND_QUICK_BUILD === "1";
