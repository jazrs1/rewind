// Tests never touch the real model caches or usage logs: the shared cache root (lib/spend.ts)
// points at a fresh temp folder, and usage-log overrides from the shell are dropped.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.REWIND_CACHE_DIR = mkdtempSync(join(tmpdir(), "rewind-test-cache-"));
delete process.env.LLM_USAGE_LOG;
delete process.env.GEMINI_USAGE_LOG;
delete process.env.GEMINI_BUDGET_USD;
