// The way back from an empty or error state: a plain "Home" link to the course home.

import Link from "next/link";

export function HomeLink() {
  return (
    <Link href="/" className="btn btn-tertiary min-w-11 w-max">
      Home
    </Link>
  );
}
