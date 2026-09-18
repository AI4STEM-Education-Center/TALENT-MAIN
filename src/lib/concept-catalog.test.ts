import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./prisma";
import {
  getActiveConceptLabels,
  registerGeneratedConcepts,
} from "./concept-catalog";

beforeEach(async () => {
  await prisma.concept.deleteMany();
});

describe("registerGeneratedConcepts", () => {
  it("persists new concepts in the admin catalog and exposes them to future agents", async () => {
    expect(
      await registerGeneratedConcepts(["  Wave   interference  "]),
    ).toEqual(["Wave interference"]);
    expect(await prisma.concept.findMany()).toEqual([
      expect.objectContaining({
        displayName: "Wave interference",
        kind: "ai_generated",
        deprecated: false,
      }),
    ]);
    expect(await getActiveConceptLabels()).toEqual(["Wave interference"]);
  });

  it("reuses curated labels without changing admin metadata", async () => {
    const original = await prisma.concept.create({
      data: {
        conceptId: "F-1",
        kind: "detailed_lo",
        displayName: "Force",
        description: "Curated description",
      },
    });
    expect(await registerGeneratedConcepts(["force", " FORCE "])).toEqual([
      "Force",
    ]);
    expect(await prisma.concept.findMany()).toEqual([original]);
  });

  it("deduplicates parallel generations and retries", async () => {
    const results = await Promise.all([
      registerGeneratedConcepts(["New concept", "NEW CONCEPT"]),
      registerGeneratedConcepts(["new concept"]),
    ]);
    expect(results[0]).toEqual(results[1]);
    await registerGeneratedConcepts(["New concept"]);
    expect(await prisma.concept.count()).toBe(1);
  });

  it("does not recreate or reactivate deprecated concepts", async () => {
    await registerGeneratedConcepts(["Old concept"]);
    await prisma.concept.updateMany({ data: { deprecated: true } });
    expect(await registerGeneratedConcepts(["OLD CONCEPT"])).toEqual([]);
    expect(await getActiveConceptLabels()).toEqual([]);
    expect(await prisma.concept.count()).toBe(1);
  });

  it("omits blank labels and no-concept sentinels", async () => {
    expect(
      await registerGeneratedConcepts(["", "  ", "None", " none "]),
    ).toEqual([]);
    expect(await prisma.concept.count()).toBe(0);
  });

  it("rejects malformed provider output before creating any records", async () => {
    for (const value of [null, "Force", ["Valid label", 42], {}]) {
      await expect(registerGeneratedConcepts(value)).rejects.toThrow(
        "array of strings",
      );
    }
    expect(await prisma.concept.count()).toBe(0);
  });
});
