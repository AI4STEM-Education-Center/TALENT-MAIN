/**
 * Pure helpers for content feedback: the 5-point rating + written explanation
 * a student leaves on the materials and simulations recommended after a quiz,
 * the one their teacher leaves on those same recommendations from the student's
 * stats page, and the one a teacher leaves on a simulation generated for them.
 *
 * Everything here is pure (no Prisma / Next imports) so it unit-tests like
 * `simulation-stats.ts`. The Prisma reads live in the routes under
 * /api/feedback, and the CSV shape in `content-feedback-csv.ts`.
 *
 * Consolidation rule, in one place because three surfaces depend on it:
 *   - a STUDENT's verdict is read by the owning teacher of the class the quiz
 *     was taken in, and by admins;
 *   - a TEACHER's verdict is read by that teacher and by admins;
 *   - admins read everything.
 * That is expressed as `routedTeacherId` on the row (see the schema), so a
 * teacher's panel is one indexed query and never has to walk classes.
 */

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/** Which surface the feedback was left on — NOT the author's account role. */
export const FEEDBACK_AUDIENCES = ["STUDENT", "TEACHER"] as const;
export type FeedbackAudience = (typeof FEEDBACK_AUDIENCES)[number];

export const FEEDBACK_SUBJECT_TYPES = ["MATERIAL", "SIMULATION"] as const;
export type FeedbackSubjectType = (typeof FEEDBACK_SUBJECT_TYPES)[number];

export function isFeedbackAudience(value: unknown): value is FeedbackAudience {
  return (
    typeof value === "string" &&
    (FEEDBACK_AUDIENCES as readonly string[]).includes(value)
  );
}

export function isFeedbackSubjectType(
  value: unknown,
): value is FeedbackSubjectType {
  return (
    typeof value === "string" &&
    (FEEDBACK_SUBJECT_TYPES as readonly string[]).includes(value)
  );
}

export const FEEDBACK_AUDIENCE_LABELS: Record<FeedbackAudience, string> = {
  STUDENT: "Student",
  TEACHER: "Teacher",
};

export const FEEDBACK_SUBJECT_TYPE_LABELS: Record<FeedbackSubjectType, string> =
  {
    MATERIAL: "Learning material",
    SIMULATION: "Simulation",
  };

// ─── The 5-point scale ────────────────────────────────────────────────────────

export const FEEDBACK_RATING_MIN = 1;
export const FEEDBACK_RATING_MAX = 5;

/** [1, 2, 3, 4, 5] — the scale, in one place, for both the form and the panel. */
export const FEEDBACK_RATING_SCALE: readonly number[] = Array.from(
  { length: FEEDBACK_RATING_MAX - FEEDBACK_RATING_MIN + 1 },
  (_, i) => FEEDBACK_RATING_MIN + i,
);

/**
 * What each point means. Worded about USEFULNESS rather than liking, because
 * that is the question the panel is trying to answer: did this recommendation
 * help the person it was shown to?
 */
export const FEEDBACK_RATING_LABELS: Record<number, string> = {
  1: "Not useful",
  2: "Slightly useful",
  3: "Somewhat useful",
  4: "Useful",
  5: "Very useful",
};

/** Longest explanation accepted by both the browser and the API. */
export const MAX_FEEDBACK_COMMENT_CHARS = 2_000;

/** True for an integer inside the 5-point scale. */
export function isValidRating(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FEEDBACK_RATING_MIN &&
    value <= FEEDBACK_RATING_MAX
  );
}

// ─── Subject identity ─────────────────────────────────────────────────────────

/** Casefold + collapse whitespace, so "Waves  Ch. 3" and "waves ch. 3" agree. */
function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The stable identity of "the thing being rated", used by the row's unique
 * index so a second submission edits the first.
 *
 * Simulations have a real id. Materials do not: they reach the student results
 * page as a durable title + page-range snapshot with no material row behind
 * them (see StoredRecommendation), so their identity is the normalized title.
 * The attempt is part of the key on purpose — the same simulation recommended
 * after a later attempt is a fresh question ("was it useful *this* time?"),
 * not an edit of the earlier answer.
 */
export function feedbackSubjectKey(input: {
  subjectType: FeedbackSubjectType;
  subjectId?: string | null;
  subjectLabel: string;
  attemptId?: string | null;
}): string {
  const subject = input.subjectId?.trim()
    ? `id:${input.subjectId.trim()}`
    : `label:${normalizeLabel(input.subjectLabel)}`;
  return [
    input.subjectType,
    subject,
    `attempt:${input.attemptId?.trim() || "none"}`,
  ].join("|");
}

// ─── Consolidation ────────────────────────────────────────────────────────────

/** The subset of a ContentFeedback row the aggregations need. */
export type FeedbackRatingRecord = {
  audience: string;
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string;
  rating: number;
};

export type FeedbackSummary = {
  count: number;
  /** Mean rating rounded to 2dp, or null when there is nothing to average. */
  average: number | null;
  /** rating (1-5) → how many rows gave it. Every point is present, even at 0. */
  distribution: Record<number, number>;
};

/** Roll a set of rows into a count, a mean, and a full 1-5 histogram. */
export function summarizeFeedback(
  rows: readonly FeedbackRatingRecord[],
): FeedbackSummary {
  const distribution: Record<number, number> = {};
  for (const point of FEEDBACK_RATING_SCALE) distribution[point] = 0;

  let total = 0;
  let counted = 0;
  for (const row of rows) {
    if (!isValidRating(row.rating)) continue;
    distribution[row.rating] += 1;
    total += row.rating;
    counted += 1;
  }

  return {
    count: counted,
    average: counted === 0 ? null : Math.round((total / counted) * 100) / 100,
    distribution,
  };
}

export type FeedbackSubjectBreakdown = FeedbackSummary & {
  subjectType: string;
  subjectLabel: string;
  subjectId: string | null;
};

/**
 * One summary row per rated subject, worst-average first — the panel's whole
 * point is to surface the recommendations that are not landing, so the
 * ordering puts them at the top. Ties break on volume (more ratings first),
 * because a 2.0 from twelve students is a stronger signal than a 2.0 from one.
 */
export function summarizeFeedbackBySubject(
  rows: readonly FeedbackRatingRecord[],
): FeedbackSubjectBreakdown[] {
  const groups = new Map<string, FeedbackRatingRecord[]>();
  for (const row of rows) {
    if (!isValidRating(row.rating)) continue;
    const key = feedbackSubjectKey({
      subjectType: row.subjectType as FeedbackSubjectType,
      subjectId: row.subjectId,
      subjectLabel: row.subjectLabel,
    });
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()]
    .map((bucket) => ({
      subjectType: bucket[0].subjectType,
      subjectLabel: bucket[0].subjectLabel,
      subjectId: bucket[0].subjectId,
      ...summarizeFeedback(bucket),
    }))
    .toSorted(
      (a, b) =>
        (a.average ?? FEEDBACK_RATING_MAX) -
          (b.average ?? FEEDBACK_RATING_MAX) ||
        b.count - a.count ||
        a.subjectLabel.localeCompare(b.subjectLabel),
    );
}

/** "4.25" / "—" — one place so the tiles and the CSV agree. */
export function formatAverageRating(average: number | null): string {
  return average === null ? "—" : average.toFixed(2);
}
