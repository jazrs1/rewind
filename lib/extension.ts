// The Rewind extension's IDs, for chrome.runtime.sendMessage from the app.
//   - The downloadable zip pins its ID: extension/manifest.json carries a public "key", so every unpacked install
//     (Load unpacked) gets PINNED_EXTENSION_ID, whatever folder it's in. The private key is never in the repo.
//   - NEXT_PUBLIC_REWIND_EXTENSION_IDS, comma-separated, lists every ID the site may talk to (add the Chrome Web
//     Store version's ID there, no code change). Unset, it's the pinned one. The single NEXT_PUBLIC_REWIND_EXTENSION_ID
//     (or John's older NEXT_PUBLIC_EXTENSION_ID), still read, comes first, with the pinned one after it.
// lib/player/zoom-remote.ts's sender tries them in order and keeps to the one that answers.

/** chrome-extension ID of the zip's public key (lib/extension-package.ts checks the manifest's key derives it). */
export const PINNED_EXTENSION_ID = "obplkjkoolikmejjcmkbbmcjhpcpbppp";

const ID = /^[a-p]{32}$/;

/** The IDs to try, in order: valid ones only, no repeats. */
export function parseExtensionIds(list: string | undefined, single: string | undefined): string[] {
  const out: string[] = [];
  const add = (s: string | undefined) => {
    const id = (s ?? "").trim();
    if (ID.test(id) && !out.includes(id)) out.push(id);
  };
  if (list !== undefined && list.trim()) list.split(",").forEach(add);
  else {
    add(single);
    add(PINNED_EXTENSION_ID);
  }
  return out;
}

/** Every ID, as the comma-separated value components pass along as `extensionId` (the sender splits it). */
export function extensionId(): string {
  // Literal reads: Next inlines NEXT_PUBLIC_ values into the browser bundle only when written out like this.
  return parseExtensionIds(process.env.NEXT_PUBLIC_REWIND_EXTENSION_IDS, process.env.NEXT_PUBLIC_REWIND_EXTENSION_ID || process.env.NEXT_PUBLIC_EXTENSION_ID).join(",");
}
