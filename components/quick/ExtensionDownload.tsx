"use client";

// The extension's download button on /extension. It's the page's one primary (action orange) until Quick build has
// questions on this device: then the student clearly has the extension, and "Start practicing" is the primary.

import { useEffect, useState } from "react";
import { QUICK_ON } from "@/lib/quick/flag";
import { browserBanks } from "@/lib/quick/store";

export function ExtensionDownload({ href }: { href: string }) {
  const [hasBank, setHasBank] = useState(false);
  useEffect(() => {
    if (!QUICK_ON) return;
    const banks = browserBanks();
    const sync = () => setHasBank(banks.list().length > 0);
    sync();
    return banks.subscribe(sync);
  }, []);
  return (
    <a href={href} download className={`btn ${hasBank ? "btn-secondary" : "btn-primary"} btn-lg px-8`} data-extension-download="">
      Download the Rewind extension
    </a>
  );
}
