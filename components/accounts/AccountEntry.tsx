"use client";

// The account entry in the demo header. With accounts off (NEXT_PUBLIC_REWIND_ACCOUNTS unset) it
// renders nothing and its code is never loaded: the menu (and Clerk behind it) is a lazy chunk the
// browser fetches only when the flag is on.

import dynamic from "next/dynamic";
import { ACCOUNTS_ON } from "@/lib/accounts/flag";
import type { AccountMenuProps } from "./AccountMenu";

const AccountMenu = ACCOUNTS_ON ? dynamic(() => import("./AccountMenu"), { ssr: false }) : null;

export function AccountEntry(props: AccountMenuProps) {
  if (!AccountMenu) return null;
  return <AccountMenu {...props} />;
}
