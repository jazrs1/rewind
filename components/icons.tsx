// One icon set (E6): a 24 px grid, 2 px stroke, round caps and joins, currentColor. Matches the engraved look of
// the transport keys. Every icon in the app comes from here; none has a fill but the play triangle's tint.

import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" {...rest}>
      {children}
    </svg>
  );
}

export const ArrowLeft = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

/** Rewind: two chevrons pointing back. */
export const RewindIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" />
  </Icon>
);

export const ExternalLink = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5h10v10M19 5L6 18" />
  </Icon>
);

export const Chevron = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const Play = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.8v12.4l10-6.2z" fill="currentColor" />
  </Icon>
);

export const Pause = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 5.5v13M16 5.5v13" strokeWidth="3.2" />
  </Icon>
);

/** Back 10 seconds: an arrow turning back, with the 10 engraved inside. */
export const Back10 = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 4.2v4.3h4.3" />
    <text x="12" y="15.4" textAnchor="middle" fontSize="8.5" fontWeight="800" fill="currentColor" stroke="none" fontFamily="var(--font-display)">
      10
    </text>
  </Icon>
);

/** Keep listening: on past the end. */
export const KeepListening = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12h13M12 6l6 6-6 6M20 5v14" />
  </Icon>
);
