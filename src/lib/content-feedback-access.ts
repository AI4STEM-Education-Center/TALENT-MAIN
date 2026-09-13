/**
 * Who may read which feedback rows, and how the panel's filters become a
 * Prisma `where`. Shared by the two read routes — /api/feedback/summary (the
 * panel) and /api/feedback/export (the CSV) — so the list a teacher sees and
 * the file they download can never disagree about scope.
 *
 * The consolidation rule itself lives on the row as `routedTeacherId` (see
 * ContentFeedback in prisma/schema.prisma): a student's verdict is routed to
 * the owning teacher of the class the quiz was taken in, and a teacher's
 * verdict to that teacher. Admins are unscoped and read both.
 */

import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isFeedbackAudience,
  isFeedbackSubjectType,
  isValidRating,
  type FeedbackAudience,
  type FeedbackSubjectType,
} from "@/lib/content-feedback";

export type FeedbackViewer =
  | { role: "ADMIN"; userId: string; teacherId: null }
  | { role: "TEACHER"; userId: string; teacherId: string };

/**
 * Resolve the session into someone allowed to READ the panel. Students submit
 * feedback but never read the consolidated view — their own verdicts come back
 * through /api/feedback/mine instead.
 */
export async function getFeedbackViewer(): Promise<FeedbackViewer | null> {
  const session = await auth();
  if (!session?.user) return null;
  if (session.user.role === "ADMIN") {
    return { role: "ADMIN", userId: session.user.id, teacherId: null };
  }
  if (session.user.role !== "TEACHER") return null;
  const teacher = await prisma.teacher.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!teacher) return null;
  return { role: "TEACHER", userId: session.user.id, teacherId: teacher.id };
}

export type FeedbackFilters = {
  audience: FeedbackAudience | null;
  subjectType: FeedbackSubjectType | null;
  rating: number | null;
  classId: string | null;
  search: string | null;
};

/** Longest accepted free-text search, so a huge `q` can't drive a huge LIKE. */
const MAX_SEARCH_CHARS = 200;

/** Read the panel's filters off a query string, dropping anything unrecognized. */
export function parseFeedbackFilters(params: URLSearchParams): FeedbackFilters {
  const audience = params.get("audience");
  const subjectType = params.get("subjectType");
  const rating = Number(params.get("rating"));
  const search = params.get("q")?.trim().slice(0, MAX_SEARCH_CHARS);

  return {
    audience: isFeedbackAudience(audience) ? audience : null,
    subjectType: isFeedbackSubjectType(subjectType) ? subjectType : null,
    rating: isValidRating(rating) ? rating : null,
    classId: params.get("classId")?.trim() || null,
    search: search || null,
  };
}

/**
 * The authorized `where` for a viewer + their filters.
 *
 * The scope clause is applied FIRST and is never derived from user input: a
 * teacher's rows are pinned to their own `routedTeacherId`, so no combination
 * of query parameters can widen the read. `contains` is left case-sensitive
 * because the datasource is SQLite, where Prisma has no `mode: "insensitive"`.
 */
export function feedbackWhere(
  viewer: FeedbackViewer,
  filters: FeedbackFilters,
): Prisma.ContentFeedbackWhereInput {
  return {
    ...(viewer.role === "TEACHER" ? { routedTeacherId: viewer.teacherId } : {}),
    ...(filters.audience ? { audience: filters.audience } : {}),
    ...(filters.subjectType ? { subjectType: filters.subjectType } : {}),
    ...(filters.rating !== null ? { rating: filters.rating } : {}),
    ...(filters.classId ? { classId: filters.classId } : {}),
    ...(filters.search
      ? {
          OR: [
            { comment: { contains: filters.search } },
            { subjectLabel: { contains: filters.search } },
            { authorName: { contains: filters.search } },
            { quizName: { contains: filters.search } },
            { className: { contains: filters.search } },
          ],
        }
      : {}),
  };
}
