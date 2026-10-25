// Privacy for the site and the Chrome extension (the store listing links here). Each claim matches the code:
// the extension (extension/README.md), accounts (lib/accounts/), the demo tutor (lib/demo/tutor-route.ts, tutor-store.ts)
// and the course pipeline's model calls (lib/llm.ts, lib/gemini.ts).

import type { Metadata } from "next";
import Link from "next/link";
import { INLINE_LINK, InfoPage, InfoSection } from "@/components/site/InfoPage";
import { pageMetadata } from "@/lib/brand/metadata";
import { CONTACT_EMAIL, CONTACT_ISSUES, PRODUCTION_URL } from "@/lib/brand/site";

export const metadata: Metadata = pageMetadata("Privacy");

export default function PrivacyPage() {
  const site = new URL(PRODUCTION_URL).host;
  return (
    <InfoPage title="Privacy" lead={`What Rewind (${site} and the Rewind Chrome extension) reads, where it goes, and how to delete it.`}>
      <InfoSection title="What the extension reads">
        <ul className="m-0 flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>Your own Canvas course</strong> on ufl.instructure.com: the modules, pages, files, assignments and announcements you can already see, read through your
            own Canvas sign-in. It reads them only when you pick a course and click Export.
          </li>
          <li>
            <strong>Your own lecture transcripts</strong> on ufl.zoom.us recordings you can open, when you click &quot;Rewind: export transcript&quot;. To play a lecture
            moment, it reads and sets only the recording&apos;s time, play or pause, and speed.
          </li>
          <li>It never reads, stores or sends your cookies, passwords or tokens, and it only works with your access: what you can&apos;t open, it can&apos;t either.</li>
        </ul>
      </InfoSection>

      <InfoSection title="Course content stays on your device">
        <p className="m-0">
          An export is saved as a file in your Downloads folder. The extension doesn&apos;t send it anywhere, and Rewind&apos;s server never receives your course content.
          Your practice answers are kept in this browser too.
        </p>
      </InfoSection>

      <InfoSection title="Who processes text">
        <p className="m-0">To build practice questions and run the tutor, Rewind sends text to these model providers:</p>
        <ul className="m-0 flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>Anthropic (Claude)</strong> writes and checks the practice questions and runs the tutor.
          </li>
          <li>
            <strong>Google (Gemini)</strong> reads slides and transcripts to find the lecture moments.
          </li>
        </ul>
        <p className="m-0">
          Building questions from your course runs on your own computer for now (beta), so course text goes straight from your computer to these providers. In the demo,
          the tutor sends your message and the demo question to Anthropic through Rewind&apos;s server. Rewind doesn&apos;t keep or log those messages or the replies: it
          keeps only usage counts under scrambled ids (never text, never your IP address), and a cookie that counts your tutor turns.
        </p>
      </InfoSection>

      <InfoSection title="What Rewind's server stores">
        <p className="m-0">
          Nothing about you, unless you sign in to save your practice. With an account, it stores your answers only: the question, your choice, right or wrong, your
          confidence and the time. No course content, no free text. Clerk, our sign-in provider, keeps your email address to sign you in.
        </p>
      </InfoSection>

      <InfoSection title="Delete my data">
        <ul className="m-0 flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>Delete my data</strong> in the account menu removes every answer from your account.
          </li>
          <li>
            <strong>Manage sign-in</strong>, in the same menu, deletes your email address and sign-in with Clerk.
          </li>
          <li>
            <strong>Clear my practice data</strong> on the Course tape removes the answers kept in this browser.
          </li>
          <li>
            To remove the extension, click <strong>Remove</strong> on its card in <code>chrome://extensions</code>. Exported files are yours: delete them from your
            Downloads folder.
          </li>
        </ul>
      </InfoSection>

      <InfoSection title="Contact">
        <p className="m-0" data-privacy-contact="">
          {CONTACT_EMAIL ? (
            <>
              Questions or requests:{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className={INLINE_LINK}>
                {CONTACT_EMAIL}
              </a>
              , or{" "}
            </>
          ) : (
            <>Questions or requests: </>
          )}
          <a href={CONTACT_ISSUES} className={INLINE_LINK}>
            open an issue on GitHub
          </a>
          . About the extension:{" "}
          <Link href="/extension" className={INLINE_LINK}>
            the extension page
          </Link>
          .
        </p>
      </InfoSection>
    </InfoPage>
  );
}
