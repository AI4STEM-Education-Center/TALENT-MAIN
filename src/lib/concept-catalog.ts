// Shared catalog for admin management and AI concept reuse.
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** Distinct display names of non-deprecated concepts, ordered by conceptId. */
export async function getActiveConceptLabels(): Promise<string[]> {
  const concepts = await prisma.concept.findMany({
    where: { deprecated: false },
    select: { displayName: true },
    orderBy: { conceptId: "asc" },
  });
  return Array.from(new Set(concepts.map((c) => c.displayName)));
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/**
 * Register labels produced by description agents and return canonical names.
 * Stable IDs make repeated/concurrent generations idempotent. Curated records
 * are reused without modification; deprecated labels are never reactivated.
 * Validate before writing because providers can fall back to unstructured JSON.
 */
export async function registerGeneratedConcepts(
  values: unknown,
): Promise<string[]> {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new Error("Generated key concepts must be an array of strings");
  }
  const labels = [...new Set((values as string[]).map(normalizeLabel))].filter(
    (label) => label && label.toLowerCase() !== "none",
  );
  if (labels.length === 0) return [];

  const existing = await prisma.concept.findMany({
    orderBy: { conceptId: "asc" },
    select: { displayName: true, deprecated: true },
  });
  const result = new Set<string>();
  for (const label of labels) {
    const key = label.toLowerCase();
    const matches = existing.filter(
      (concept) => normalizeLabel(concept.displayName).toLowerCase() === key,
    );
    const active = matches.find((concept) => !concept.deprecated);
    if (active) {
      result.add(active.displayName);
      continue;
    }
    if (matches.length > 0) continue;

    const conceptId = `AI-${createHash("sha256").update(key).digest("hex")}`;
    const concept = await prisma.concept.upsert({
      where: { conceptId },
      create: {
        conceptId,
        kind: "ai_generated",
        displayName: label,
        notes: "Generated during AI material description analysis.",
      },
      update: {},
      select: { displayName: true, deprecated: true },
    });
    if (!concept.deprecated) result.add(concept.displayName);
  }
  return [...result];
}
