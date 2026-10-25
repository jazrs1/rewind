"use client";

// Clerk sign-in for the account menu: email code only (passwords and social logins are off in the
// Clerk dashboard). Loaded only with accounts on and fake sign-in off, and mounted only once the student
// asks to sign in or this site already has a Clerk session (components/accounts/AccountMenu.tsx). The
// provider wraps the menu alone, so no page is made dynamic by it. Its sign-in screen says what the
// account keeps (lib/accounts/privacy.ts).

import { ClerkProvider, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useEffect, useRef, type ReactNode } from "react";
import { PRIVACY_SIGN_IN } from "@/lib/accounts/privacy";
import type { AccountAuth } from "./AccountMenu";

type Props = { children: (auth: AccountAuth) => ReactNode; openOnLoad?: boolean };

export default function ClerkAccount({ children, openOnLoad = false }: Props) {
  return (
    <ClerkProvider publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY} localization={{ signIn: { start: { subtitle: PRIVACY_SIGN_IN } } }}>
      <ClerkAuth openOnLoad={openOnLoad}>{children}</ClerkAuth>
    </ClerkProvider>
  );
}

function ClerkAuth({ children, openOnLoad }: Props) {
  const { isLoaded, userId } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  // Mounted by a click on "Sign in to save": open the sign-in once Clerk is ready.
  const opened = useRef(false);
  useEffect(() => {
    if (openOnLoad && isLoaded && !userId && !opened.current) {
      opened.current = true;
      clerk.openSignIn();
    }
  }, [openOnLoad, isLoaded, userId, clerk]);
  return children({
    state: !isLoaded ? "loading" : userId ? "signed-in" : "signed-out",
    userId: userId ?? null,
    label: user?.primaryEmailAddress?.emailAddress ?? null,
    signIn: () => clerk.openSignIn(),
    signOut: () => clerk.signOut(),
    manage: () => clerk.openUserProfile(),
  });
}
