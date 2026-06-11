// Presigning helpers for question figures (images cropped from quiz PDFs).
// Kept tiny and tolerant: a question whose figure can't be presigned (e.g. the
// underlying object was deleted, or S3 config is missing) simply loses its
// `figureUrl` rather than failing the whole request — mirroring the
// drop-on-failure tolerance of `mapPresignedRecommendations` in exam-results.

import { presignGetUrl, getS3Config } from "@/lib/storage";

/** The figure-location columns we read off a Question row. */
type FigureSource = { figureStorageKey: string | null; figureBucket: string | null };

/**
 * Presign a short-lived GET URL for a question's figure, or null when the
 * question has no figure or presigning fails. Falls back to the configured
 * default bucket when the row carries a key but no explicit bucket.
 */
export async function presignQuestionFigure(q: FigureSource): Promise<string | null> {
  if (!q.figureStorageKey) return null;
  try {
    const bucket = q.figureBucket ?? getS3Config().bucket;
    return await presignGetUrl(bucket, q.figureStorageKey, 3600);
  } catch {
    // Object gone / S3 misconfigured / presign error — drop the figure silently.
    return null;
  }
}

/**
 * Map a list of question rows to the student-safe shape: drop the raw figure
 * storage key + bucket and replace them with a transient presigned `figureUrl`
 * (null when absent or un-presignable). All other fields pass through.
 */
export async function attachFigureUrls<
  T extends FigureSource
>(questions: T[]): Promise<Array<Omit<T, "figureStorageKey" | "figureBucket"> & { figureUrl: string | null }>> {
  return Promise.all(
    questions.map(async (q) => {
      const figureUrl = await presignQuestionFigure(q);
      const { figureStorageKey: _key, figureBucket: _bucket, ...rest } = q;
      return { ...rest, figureUrl };
    })
  );
}
