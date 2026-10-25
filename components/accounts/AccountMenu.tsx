"use client";

// Sign in to save your practice (Accounts Lite). Loaded only with accounts on (AccountEntry). Signed in,
// this device's attempts are copied into the student's account and the account's come back, through
// the account-backed store (lib/accounts/account-store.ts); signed out, nothing is sent. The account
// keeps only the student's own answers, never course text.

import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createAccountAttemptStore, releaseDevice, type AccountApi, type AccountStore, type DeviceState, type QuestionLookup } from "@/lib/accounts/account-store";
import { accountApi, isReadsPaused, isStorageDown } from "@/lib/accounts/api";
import { deviceOwner } from "@/lib/accounts/device";
import type { AccountAttempt } from "@/lib/accounts/schema";
import { browserAttemptStore, courseKey, setAccountStores, type StorageLike } from "@/lib/attempts/store";
import { IMPORT_DOCS, IMPORT_FULL } from "@/lib/accounts/flag";
import { hasClerkSession, PRIVACY_MENU } from "@/lib/accounts/privacy";
import { FakeAccount } from "./FakeAccount";

// Clerk's chunk (and Clerk with it) is fetched only when it is first rendered: React.lazy calls the import then and
// never preloads (next/dynamic did, so a visit that never signed in still downloaded Clerk's code).
const ClerkAccount = lazy(() => import("./ClerkAccount"));

export interface AccountMenuProps {
  course: string;
  /** Each question's topic and stem, from the bundle this page already has: records from the account get them back from here. */
  questions: { id: string; topic: string; stem: string | null }[];
  /** Fake sign-in for tests (lib/accounts/fake.ts); always false in production. */
  fake: boolean;
}

/** What the sign-in (Clerk or the test fake) tells the menu. */
export interface AccountAuth {
  state: "loading" | "signed-out" | "signed-in";
  userId: string | null;
  /** The email shown for the signed-in student. */
  label: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** A sign-in form to show in place of the button (the fake's), if any. */
  prompt?: ReactNode;
  /** Closes that form (Esc). */
  cancel?: () => void;
  /** Opens the sign-in's own settings, where the student can delete it (Clerk's user profile), if there is one. */
  manage?: () => void;
}

/** How often a sync is retried while saving is down. */
const RETRY_MS = 30_000;

// The import link's address and name live with the flag, so the landing page can use them without account code.
export { IMPORT_DOCS } from "@/lib/accounts/flag";

// The app's buttons (app/elevation.css): secondary (2 px outline in the label colour), and the destructive one in red pen.
const secondary = "btn btn-secondary min-h-11 px-4 text-[15px]";
const destructive = "btn min-h-11 border-red-pen bg-red-pen px-4 text-[15px] text-label";

const deviceStorage = (): StorageLike | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export default function AccountMenu(props: AccountMenuProps) {
  const render = (auth: AccountAuth) => <AccountPanel {...props} auth={auth} />;
  // Clerk (its script and its cookies) loads only once the student asks to sign in, or when this site already has a
  // Clerk session cookie: a visit that never signs in never contacts Clerk.
  const [clerk, setClerk] = useState(() => !props.fake && typeof document !== "undefined" && hasClerkSession(document.cookie));
  const [openOnLoad, setOpenOnLoad] = useState(false);
  if (props.fake) return <FakeAccount>{render}</FakeAccount>;
  const signedOut = (loading: boolean): AccountAuth => ({
    state: loading ? "loading" : "signed-out",
    userId: null,
    label: null,
    signIn: () => {
      setOpenOnLoad(true);
      setClerk(true);
    },
    signOut: async () => {},
  });
  if (!clerk) return render(signedOut(false));
  return (
    <Suspense fallback={render(signedOut(true))}>
      <ClerkAccount openOnLoad={openOnLoad}>{render}</ClerkAccount>
    </Suspense>
  );
}

function AccountPanel({ course, questions, auth }: AccountMenuProps & { auth: AccountAuth }) {
  const key = courseKey(course);
  const lookup = useMemo<QuestionLookup>(() => {
    const byId = new Map(questions.map((q) => [q.id, { topic: q.topic, stem: q.stem }]));
    return (id) => byId.get(id) ?? null;
  }, [questions]);
  const [saved, setSaved] = useState<number | null>(null);
  // Saving is down ("down": a retry every half minute), or today's reads for everyone are used up ("paused": the
  // device keeps everything; answers and "online" still retry, the half-minute timer doesn't).
  const [unavailable, setUnavailable] = useState<false | "down" | "paused">(false);
  // Saving is down: a retry is scheduled. A delete that couldn't reach the account says so and changes nothing.
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  // This user's answers on this device that the account doesn't have: kept because the account holds its 2,000
  // (lib/accounts/kv.ts), refused as older than a delete, or not sent yet (lib/accounts/account-store.ts).
  const [device, setDevice] = useState<DeviceState>({ full: 0, stale: 0, unsynced: 0 });
  // Clearing this course reached the device but not the account.
  const [clearFailed, setClearFailed] = useState(false);
  const storeRef = useRef<AccountStore | null>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const signInRef = useRef<HTMLButtonElement>(null);
  const unavailableRef = useRef<false | "down" | "paused">(false);
  useEffect(() => {
    unavailableRef.current = unavailable;
  }, [unavailable]);
  const descId = useId();
  const userId = auth.state === "signed-in" ? auth.userId : null;

  // The account's count for this course, from every answer the server gives back.
  const api = useMemo<AccountApi>(() => {
    // Sent with the signed-in user's id: a reply for someone else (signed out and in elsewhere) is refused.
    const base = accountApi(undefined, userId ?? undefined);
    const count = (list: AccountAttempt[]) => {
      setSaved(list.filter((a) => a.course === key).length);
      setUnavailable(false);
      // The account answered, so an earlier "couldn't delete" is stale.
      setDeleteFailed(false);
      setClearFailed(false);
      return list;
    };
    return {
      get: async () => {
        const res = await base.get();
        count(res.attempts);
        return res;
      },
      post: async (a) => {
        const res = await base.post(a);
        count(res.attempts);
        return res;
      },
      del: base.del,
    };
  }, [key, userId]);

  // No one signed in (signed out here, or the session ended elsewhere): the device keeps only what was
  // answered signed out; any account's attempts leave it (lib/accounts/device.ts).
  useEffect(() => {
    if (auth.state === "signed-out") releaseDevice(browserAttemptStore(key), deviceOwner(key, deviceStorage));
  }, [auth.state, key]);

  // Signed in: the account-backed store takes over for this course and syncs now, after each answer
  // and whenever the browser comes back online. If the account can't be reached (or its store is
  // stopped), saving says it's unavailable and practice stays on this device.
  useEffect(() => {
    if (!userId) return;
    const owner = deviceOwner(key, deviceStorage);
    const s = createAccountAttemptStore({
      course: key,
      userId,
      local: browserAttemptStore(key),
      owner,
      api,
      lookup,
      onError: (e) => setUnavailable(isReadsPaused(e) ? "paused" : "down"),
      onState: setDevice,
      onClearFailed: () => setClearFailed(true),
    });
    setAccountStores((c) => (courseKey(c) === key ? s : browserAttemptStore(c)));
    storeRef.current = s;
    const sync = () => {
      s.sync().catch((e) => setUnavailable(isReadsPaused(e) ? "paused" : "down"));
    };
    sync();
    window.addEventListener("online", sync);
    // While saving is down, try again every half minute (every answer and "online" also retry). This device's answers
    // are all re-sent each time, so nothing given in the meantime is lost.
    const retry = window.setInterval(() => {
      if (unavailableRef.current === "down") sync();
    }, RETRY_MS);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener("online", sync);
      // The session is over (signed out, or another user): a sync still in flight must not touch the device.
      s.dispose();
      setAccountStores(null);
      storeRef.current = null;
    };
  }, [userId, key, api, lookup]);

  useEffect(() => {
    if (confirming) yesRef.current?.focus();
  }, [confirming]);

  const closeConfirm = () => {
    setConfirming(false);
    requestAnimationFrame(() => deleteRef.current?.focus());
  };

  const deleteAll = async () => {
    const store = storeRef.current;
    if (!store) return;
    setDeleteFailed(false);
    try {
      await store.deleteAll();
      setSaved(0);
      setDeleted(true);
      closeConfirm();
    } catch (e) {
      // Nothing was deleted from the account, so this device's copy stays too: the two never disagree about what is gone.
      setDeleteFailed(true);
      if (isStorageDown(e)) setUnavailable("down");
    }
  };

  const signOut = async () => {
    // One last sync, so answers given while signed in reach the account before they leave the device.
    await storeRef.current?.flush();
    await auth.signOut();
  };

  const escape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return false;
    e.stopPropagation();
    // In the phone's menu sheet (a modal dialog), Esc closes this step only, not the sheet.
    e.preventDefault();
    return true;
  };

  // The header shows only the account button; signed in, it opens this menu, and signed out with the test
  // sign-in, its form opens under it. Esc closes either and puts focus back on the button; so does a click outside.
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const menuId = useId();
  const signedIn = auth.state === "signed-in";
  const menuOpen = open && signedIn;
  const prompting = !signedIn && !!auth.prompt;
  const cancelRef = useRef(auth.cancel);
  useEffect(() => {
    cancelRef.current = auth.cancel;
  });

  useEffect(() => {
    if (!menuOpen && !prompting) return;
    const outside = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      cancelRef.current?.();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen, prompting]);

  // Opening the menu moves focus into it.
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
  }, [menuOpen]);

  const closeMenu = () => {
    setOpen(false);
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  // The short form is shown; the full sentence is its title and its name for screen readers.
  const importLine = (
    <a href={IMPORT_DOCS} title={IMPORT_FULL} aria-label={IMPORT_FULL} className="btn btn-tertiary -mx-2 min-h-11 flex-col items-start gap-0.5 py-2 text-left">
      <span className="text-[15px]">Import your own course (beta)</span>
      <span className="text-[13px] font-normal text-label-muted">Runs on your computer for now</span>
    </a>
  );

  if (!signedIn) {
    return (
      <div ref={rootRef} data-account="signed-out" className="flex items-center">
        {/* "Sign in to save" is shown; the name is the whole sentence (it starts with what's shown). */}
        <button
          ref={signInRef}
          type="button"
          data-account-button=""
          aria-label="Sign in to save your practice"
          aria-expanded={auth.cancel ? prompting : undefined}
          disabled={auth.state === "loading"}
          onClick={prompting ? auth.cancel : auth.signIn}
          className="btn btn-secondary min-h-11 px-4 text-[15px] whitespace-nowrap"
        >
          Sign in to save
        </button>
        {prompting ? (
          <div
            className="account-pop"
            onKeyDown={(e) => {
              if (!escape(e)) return;
              auth.cancel?.();
              requestAnimationFrame(() => signInRef.current?.focus());
            }}
          >
            {auth.prompt}
          </div>
        ) : null}
      </div>
    );
  }

  const alert = unavailable || deleteFailed;
  return (
    <div ref={rootRef} data-account="signed-in" className="flex items-center">
      <button
        ref={menuButtonRef}
        type="button"
        data-account-button=""
        data-alert={alert ? "" : undefined}
        aria-label={unavailable === "paused" && !deleteFailed ? "Your account: syncing is paused" : alert ? "Your account: saving is unavailable" : "Your account"}
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={() => (menuOpen ? setOpen(false) : setOpen(true))}
        onKeyDown={(e) => escape(e) && closeMenu()}
        className="account-avatar"
      >
        {auth.label ? (
          <span aria-hidden="true">{auth.label.charAt(0).toUpperCase()}</span>
        ) : (
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round">
            <circle cx="12" cy="8.5" r="3.75" />
            <path d="M4.75 19.5c1.4-3.3 4-5 7.25-5s5.85 1.7 7.25 5" />
          </svg>
        )}
      </button>
      {menuOpen ? (
        <section ref={menuRef} id={menuId} aria-label="Your account" className="account-pop text-[15px]" onKeyDown={(e) => escape(e) && closeMenu()}>
          <p role="status" className="m-0 leading-snug text-label">
            {deleteFailed
              ? "Couldn't delete your data right now. It's still saved, here and in your account. Try again later."
              : unavailable === "paused"
                ? "Syncing is paused for today. Everything stays on this device and syncs when it resumes."
                : unavailable
                  ? "Saving is unavailable right now. Your practice stays on this device."
                  : saved === null
                    ? "Saving your practice to your account…"
                    : deleted && saved === 0
                      ? "Deleted. Your account has no practice data."
                      : `${saved} practice ${saved === 1 ? "answer" : "answers"} saved in your account${auth.label ? ` (${auth.label})` : ""}.`}
          </p>
          {clearFailed ? (
            <p data-account-clear-failed="" className="m-0 text-[13px] leading-snug text-label-muted">
              This course was cleared on this device, but not in your account. Its answers come back at the next sync.
            </p>
          ) : null}
          {device.full ? (
            <p data-account-full="" className="m-0 text-[13px] leading-snug text-label-muted">
              Your account is full; newer answers stay on this device.
            </p>
          ) : null}
          {device.stale ? (
            <p data-account-stale="" className="m-0 text-[13px] leading-snug text-label-muted">
              {device.stale} {device.stale === 1 ? "answer" : "answers"} from before your last delete {device.stale === 1 ? "wasn't" : "weren't"} saved; they stay on this
              device.
            </p>
          ) : null}
          {device.unsynced ? (
            <p data-account-unsynced="" className="m-0 text-[13px] leading-snug text-label-muted">
              {device.unsynced} {device.unsynced === 1 ? "answer isn't" : "answers aren't"} saved yet and will be removed if someone else signs in here.
            </p>
          ) : null}
          <p data-account-privacy="" className="m-0 text-[13px] leading-snug text-label-muted">
            {PRIVACY_MENU}
          </p>
          {auth.manage ? (
            <button type="button" onClick={auth.manage} className="btn btn-tertiary -mx-2 min-h-11 self-start text-[15px]">
              Manage sign-in
            </button>
          ) : null}
          {confirming ? (
            <div role="group" aria-labelledby={descId} onKeyDown={(e) => escape(e) && closeConfirm()} className="flex flex-col gap-3 rounded-[10px] border border-deck-line p-3">
              {/* The question first, big; what it covers in one short line. */}
              <div id={descId} className="flex flex-col gap-1">
                <p className="m-0 font-display text-[18px] leading-tight font-bold">Delete your practice data?</p>
                <p className="m-0 text-[14px] leading-snug text-label-muted">
                  Your account&apos;s answers and this course&apos;s answers on this device. Your sign-in stays. This can&apos;t be undone. Answers on another device that hasn&apos;t synced yet may come back when it next syncs.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button ref={yesRef} type="button" onClick={() => void deleteAll()} className={destructive}>
                  Yes, delete my data
                </button>
                <button type="button" onClick={closeConfirm} className={secondary}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  void signOut().then(() => requestAnimationFrame(() => signInRef.current?.focus()));
                }}
                className={`${secondary} flex-1`}
              >
                Sign out
              </button>
              <button
                ref={deleteRef}
                type="button"
                onClick={() => {
                  setDeleted(false);
                  setConfirming(true);
                }}
                className={`${secondary} flex-1`}
              >
                Delete my data
              </button>
            </div>
          )}
          <hr className="account-pop-rule" />
          {importLine}
        </section>
      ) : null}
    </div>
  );
}
