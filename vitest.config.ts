import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The app's "@/..." imports (tsconfig paths), for tests that load proxy.ts or a component.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `import "server-only"` throws outside React's server build; in tests it is the empty module.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    // extension/ and scripts/radar/ are plain JS with their own node test runners (npm run test:worker).
    exclude: ["**/node_modules/**", ".claude/**"],
    setupFiles: ["./vitest.setup.ts"],
    include: ["lib/**/*.test.ts", "scripts/spike/**/*.test.ts", "scripts/eval/**/*.test.ts", "app/**/*.test.ts?(x)"],
  },
});
