// The Rewind wordmark: the "Tape talk" mark (public/brand/rewind-mark.svg, the one source for every size)
// at 24 px and "Rewind" in Bricolage 800. The mark is decorative; the text is the name. It sits 1 px low
// so the text centres on the bubble, not on the box that holds its tail.

import Image from "next/image";

export function Mark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return <Image src="/brand/rewind-mark.svg" alt="" width={size} height={size} unoptimized priority className={`flex-none ${className}`} />;
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-display text-[22px] leading-none font-extrabold tracking-[-0.5px] text-label ${className}`}>
      <Mark className="relative top-px" />
      Rewind
    </span>
  );
}
