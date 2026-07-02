// Shared read-only accessor for the active concept catalog. Used to constrain
// AI-generated key-concept labels (material description, and later recommendation
// misconception labeling) to the curated list maintained at /admin/concepts.
//
// Material generation fails closed when this list is empty; free-form concept
// generation is never allowed.

import { prisma } from "@/lib/prisma";

/**
 * Distinct display names of all non-deprecated concepts, ordered by conceptId.
 */
export async function getActiveConceptLabels(): Promise<string[]> {
  const concepts = await prisma.concept.findMany({
    where: { deprecated: false },
    select: { displayName: true },
    orderBy: { conceptId: "asc" },
  });
  return Array.from(new Set(concepts.map((c) => c.displayName)));
}
