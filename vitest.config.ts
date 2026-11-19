import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Default environment is Node. DOM-dependent specs (qti, components) opt in
    // per-file with a `// @vitest-environment jsdom` docblock.
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Each Vitest worker clones test/test-template.db into its own per-worker
    // SQLite file (see vitest.setup.ts), so files run in parallel with no
    // write contention or cross-file bleed.
    fileParallelism: true,
    // Push the schema to the throwaway test DB once before any spec runs.
    globalSetup: ["./test/global-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/app/api/**", "src/proxy.ts"],
      exclude: ["src/lib/prisma.ts", "**/*.d.ts"],
    },
  },
});
