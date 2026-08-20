import { defineConfig } from "vitest/config";

/**
 * Release metadata and changelog parsing are pure file/string checks. Keeping
 * them in a database-free lane lets release managers validate a weekly bump
 * without invoking the main suite's destructive throwaway-DB reset.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/version.test.ts", "test/release-metadata.test.ts"],
  },
});
