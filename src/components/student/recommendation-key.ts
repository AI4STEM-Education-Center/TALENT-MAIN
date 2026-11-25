import type { PresignedRecommendation } from "@/lib/exam-results";

/**
 * Stable identity of one recommendation card within an attempt. The material id
 * keeps two different materials with the same title and pages apart.
 */
export const recommendationKey = (rec: PresignedRecommendation) =>
  `${rec.materialId ?? ""}-${rec.materialTitle}-${rec.pageRange.start}-${rec.pageRange.end}`;
