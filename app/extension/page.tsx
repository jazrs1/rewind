// The extension's download page: the zip (built from extension/ with the site, app/extension/rewind-extension.zip),
// how to load it in Chrome, and that the demo doesn't need it.

import type { Metadata } from "next";
import Link from "next/link";
import { BuildPractice } from "@/components/quick/BuildPractice";
import { ExtensionDownload } from "@/components/quick/ExtensionDownload";
import { QUICK_ON } from "@/lib/quick/flag";
import { INLINE_LINK, InfoPage, InfoSection } from "@/components/site/InfoPage";
import { pageMetadata } from "@/lib/brand/metadata";
import { EXTENSION_FOLDER, EXTENSION_ZIP } from "@/lib/extension-package";

export const metadata: Metadata = pageMetadata("Chrome extension");

export default function ExtensionPage() {
  return (
    <InfoPage title="The Rewind extension" lead="It brings your own course into Rewind: it exports the Canvas course and the lecture transcripts you can already see, and plays the lecture moment when you miss a question.">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <ExtensionDownload href={`/extension/${EXTENSION_ZIP}`} />
        <span className="text-[15px] text-label-muted">For Chrome on a computer. A .zip file.</span>
      </div>

      <InfoSection title="Install it in three steps">
        <ol className="m-0 flex list-decimal flex-col gap-3 pl-6" data-install-steps="">
          <li>
            Unzip <code>{EXTENSION_ZIP}</code>. You get a folder named <code>{EXTENSION_FOLDER}</code>.
          </li>
          <li>
            Open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong> (top right).
          </li>
          <li>
            Click <strong>Load unpacked</strong> and choose the <code>{EXTENSION_FOLDER}</code> folder. Then pin Rewind from the puzzle-piece menu.
          </li>
        </ol>
      </InfoSection>

      <p className="m-0 rounded-md border border-deck-line px-4 py-3 text-[18px] leading-snug" data-extension-demo-note="">
        You don&apos;t need it for the demo.{" "}
        <Link href="/demo/practice" className={INLINE_LINK}>
          The demo
        </Link>{" "}
        runs on a real UF course, used with permission, in any browser, with nothing to install.
      </p>

      {QUICK_ON ? <BuildPractice /> : null}

      <InfoSection title="What it can see">
        <p className="m-0">
          Only your own Canvas course and lecture recordings, with your own sign-in, and only when you ask it to export. Course content stays on your device. See{" "}
          <Link href="/privacy" className={INLINE_LINK}>
            Privacy
          </Link>
          .
        </p>
      </InfoSection>
    </InfoPage>
  );
}
