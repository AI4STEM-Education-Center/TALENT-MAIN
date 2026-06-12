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

/** The image-location columns we read off an Option row (an image answer-choice). */
type OptionImageSource = { imageStorageKey?: string | null; imageBucket?: string | null };

/**
 * Presign a short-lived GET URL for an image answer-choice, or null when the
 * option has no image or presigning fails. Mirrors `presignQuestionFigure`.
 */
export async function presignOptionImage(o: OptionImageSource): Promise<string | null> {
  if (!o.imageStorageKey) return null;
  try {
    const bucket = o.imageBucket ?? getS3Config().bucket;
    return await presignGetUrl(bucket, o.imageStorageKey, 3600);
  } catch {
    return null;
  }
}

/**
 * Map a list of question rows so each option's raw image key + bucket are
 * dropped and replaced with a transient presigned `imageUrl` (null when absent
 * or un-presignable). The question fields and every other option field pass
 * through. Compose after `attachFigureUrls` to cover both figures and choices.
 */
export async function attachOptionImageUrls<
  O extends OptionImageSource,
  T extends { options: O[] }
>(
  questions: T[]
): Promise<
  Array<Omit<T, "options"> & { options: Array<Omit<O, "imageStorageKey" | "imageBucket"> & { imageUrl: string | null }> }>
> {
  return Promise.all(
    questions.map(async (q) => {
      const options = await Promise.all(
        q.options.map(async (o) => {
          const imageUrl = await presignOptionImage(o);
          const { imageStorageKey: _key, imageBucket: _bucket, ...rest } = o;
          return { ...rest, imageUrl };
        })
      );
      return { ...q, options };
    })
  );
}
