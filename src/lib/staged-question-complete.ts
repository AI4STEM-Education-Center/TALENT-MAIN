import { normalizeNumericValue } from "@/lib/quiz-scoring";
import type { StagedQuestion } from "@/lib/quiz-extraction";

/**
 * Local mirror of the server's commit-completeness rules. A figure or image
 * option with a still-pending crop (a bbox but no storage key) counts as
 * complete here, because the crop is drawn + uploaded during the commit step.
 * An image option with NO crop box yet is incomplete — there is nothing to crop.
 */
export function isQuestionComplete(q: StagedQuestion): boolean {
  if (q.type === "NUMERIC") {
    return normalizeNumericValue(q.numericAnswer) !== null;
  }
  if (q.options.length < 2) return false;
  if (q.options.some((o) => o.isCorrect === null)) return false;
  if (
    q.options.some(
      (o) => o.isImage === true && !(o.imageBbox ?? o.imageStorageKey),
    )
  )
    return false;
  const correct = q.options.filter((o) => o.isCorrect === true).length;
  if (q.type === "MULTI_SELECT") return correct >= 1;
  return correct === 1; // MULTIPLE_CHOICE / TRUE_FALSE
}
