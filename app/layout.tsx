import type { Metadata, Viewport } from "next";
import {
  Atkinson_Hyperlegible,
  Bricolage_Grotesque,
  Caveat,
  Source_Serif_4,
} from "next/font/google";
import { rootMetadata, THEME } from "@/lib/brand/metadata";
import { OfflineNote } from "@/components/states/OfflineNote";
import "./globals.css";

// Titles and big numbers (800); section headings on the deck (700, course home).
const display = Bricolage_Grotesque({
  variable: "--font-bricolage",
  weight: ["700", "800"],
  subsets: ["latin"],
});

// Anything printed on the exam paper.
const serif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

// Handwriting only.
const hand = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
});

// Everything else.
const sans = Atkinson_Hyperlegible({
  variable: "--font-atkinson",
  weight: ["400", "700"],
  subsets: ["latin"],
});

// Titles ("%s · Rewind"), the description and the link previews (lib/brand/metadata.ts). The icons are
// files: app/icon.svg, app/favicon.ico, app/apple-icon.png and app/manifest.ts.
export const metadata: Metadata = rootMetadata();

// viewport-fit=cover: without it env(safe-area-inset-*) is 0 on iPhone, and Safari's floating toolbar covers the
// last button on a phone screen (app/globals.css --phone-bottom-room).
export const viewport: Viewport = { themeColor: THEME, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${serif.variable} ${hand.variable} ${sans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-deck text-label font-sans">
        <OfflineNote />
        {children}
      </body>
    </html>
  );
}
