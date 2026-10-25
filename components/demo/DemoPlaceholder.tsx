import Link from "next/link";

/** A demo screen that isn't built on the demo bundle yet. */
export function DemoPlaceholder({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-3 px-4 py-12 sm:px-8">
      <h1 className="font-display text-3xl font-extrabold">{title}</h1>
      <p className="text-label-muted">{children}</p>
      <div className="pt-2">
        <Link
          href="/demo/practice"
          className="inline-flex min-h-11 items-center rounded-md bg-action px-6 font-bold text-ink transition-transform duration-150 hover:-translate-y-0.5"
        >
          Practice the demo course
        </Link>
      </div>
    </main>
  );
}

/** The demo bundle isn't in public/ (see lib/demo/bundle.ts). */
export function DemoMissing() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-3 px-4 py-12 sm:px-8">
      <h1 className="font-display text-3xl font-extrabold">The demo course isn&apos;t here</h1>
      <p className="text-label-muted">
        This build has no demo bundle. Run <code>node scripts/demo/export-demo.ts</code> to write public/demo/course/.
      </p>
    </main>
  );
}
