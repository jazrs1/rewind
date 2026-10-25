import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Worker-owned plain JS, checked by npm run test:worker.
    "extension/**",
    "scripts/radar/**",
    ".cache/**",
    // Agent worktrees live inside the repo folder.
    ".claude/**",
    ".vercel/**",
  ]),
]);

export default eslintConfig;
