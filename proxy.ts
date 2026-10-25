// Next 16's proxy (formerly middleware), only for the account API: Clerk reads the session there so
// the route handlers' `auth()` works. Pages never pass through it, so they stay static. With accounts
// off, or fake sign-in on (tests), it does nothing and Clerk never loads.

import { NextResponse, type NextFetchEvent, type NextMiddleware, type NextRequest } from "next/server";
import { fakeAuthEnabled } from "@/lib/accounts/fake";
import { accountsEnabled } from "@/lib/accounts/flag";

let clerk: NextMiddleware | null = null;

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  if (!accountsEnabled() || fakeAuthEnabled()) return NextResponse.next();
  clerk ??= (await import("@clerk/nextjs/server")).clerkMiddleware();
  return clerk(req, event);
}

export const config = {
  matcher: ["/api/account/:path*"],
};
