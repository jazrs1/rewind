"use client";

// Test sign-in (REWIND_FAKE_AUTH=1, never in production; lib/accounts/fake.ts): an email box that sets
// the fake session cookie. No code, no Clerk, no network.

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { FAKE_COOKIE, FAKE_ID, fakeUserId } from "@/lib/accounts/fake";
import { PRIVACY_SIGN_IN } from "@/lib/accounts/privacy";
import type { AccountAuth } from "./AccountMenu";

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const readId = () => {
  const v = document.cookie.split("; ").find((c) => c.startsWith(`${FAKE_COOKIE}=`))?.slice(FAKE_COOKIE.length + 1) ?? null;
  return v && FAKE_ID.test(v) ? v : null;
};
const setCookie = (value: string, maxAge: number) => {
  document.cookie = `${FAKE_COOKIE}=${value}; path=/; max-age=${maxAge}; SameSite=Lax`;
  for (const fn of [...listeners]) fn();
};

export function FakeAccount({ children }: { children: (auth: AccountAuth) => ReactNode }) {
  const userId = useSyncExternalStore(subscribe, readId, () => null);
  const [asking, setAsking] = useState(false);
  const [email, setEmail] = useState("");

  const prompt = asking ? (
    <form
      aria-label="Test sign-in"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!email.trim()) return;
        setCookie(fakeUserId(email), 3600);
        setAsking(false);
      }}
    >
      <label className="flex flex-col gap-1.5 text-[15px] font-bold text-label">
        Email (test sign-in)
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-h-11 rounded-[10px] border border-deck-line bg-deck px-3 font-normal text-label"
        />
      </label>
      <button type="submit" className="btn btn-secondary min-h-11 px-4 text-[15px]">
        Sign in
      </button>
      <p data-account-privacy="" className="m-0 text-[13px] leading-snug text-label-muted">
        {PRIVACY_SIGN_IN}
      </p>
    </form>
  ) : undefined;

  return children({
    state: userId ? "signed-in" : "signed-out",
    userId,
    label: null,
    signIn: () => setAsking(true),
    signOut: async () => setCookie("", 0),
    prompt,
    cancel: () => setAsking(false),
  });
}
