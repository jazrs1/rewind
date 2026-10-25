// The download stage every entry point runs (scripts/pipeline/front-half.ts and run.ts): local
// copies first (matchLocal, ambiguous matches reported, never guessed), then signed links ONLY
// when the network path is switched on (--download or REWIND_ENABLE_DOWNLOAD=1). By default
// nothing is fetched: files not present or local are recorded as "download disabled".
// Scripts must call this, never downloadAll directly (download-stage.test.ts checks).

import { downloadAll, matchLocal, type AmbiguousLocal, type DownloadDeps, type DownloadResult, type DownloadTarget, type LocalFile } from "./download.ts";

/** The network download path is on only with --download or REWIND_ENABLE_DOWNLOAD=1. */
export function networkEnabled(argv: readonly string[], env: Record<string, string | undefined>): boolean {
  return argv.includes("--download") || env.REWIND_ENABLE_DOWNLOAD === "1";
}

export interface DownloadStageResult {
  downloads: DownloadResult[];
  local: Map<number, LocalFile>;
  ambiguous: AmbiguousLocal[];
  /** Local files no target took (paths relative to the local folder). */
  unmatched: string[];
  matchedByRole: Record<string, number>;
  network: boolean;
}

export async function downloadStage(
  targets: DownloadTarget[],
  localFiles: LocalFile[],
  deps: DownloadDeps,
  opts: { argv: readonly string[]; env: Record<string, string | undefined> },
): Promise<DownloadStageResult> {
  const ambiguous: AmbiguousLocal[] = [];
  const local = matchLocal(targets, localFiles, undefined, ambiguous);
  const used = new Set([...local.values()].map((f) => f.path));
  const matchedByRole: Record<string, number> = {};
  for (const t of targets) if (local.has(t.fileId)) matchedByRole[t.role] = (matchedByRole[t.role] ?? 0) + 1;
  const unmatched = localFiles.filter((f) => !used.has(f.path)).map((f) => f.path).sort();
  const network = networkEnabled(opts.argv, opts.env);
  const downloads = await downloadAll(targets, deps, { local, network });
  return { downloads, local, ambiguous, unmatched, matchedByRole, network };
}
