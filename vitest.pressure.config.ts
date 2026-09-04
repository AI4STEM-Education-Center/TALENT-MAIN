import { defineConfig } from "vitest/config";

/** Pressure result/recommendation logic is pure and needs no destructive DB setup. */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/pressure-results.test.ts",
      "test/pressure-size-recommendation.test.ts",
    ],
  },
});
