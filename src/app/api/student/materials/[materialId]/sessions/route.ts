import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasResearchConsent } from "@/lib/consent";
import { rateLimit } from "@/lib/rate-limit";
import { parseJsonBody, resourceSessionCreateSchema } from "@/lib/validation";
import { parseStoredRecommendations } from "@/lib/exam-results";
import { getStudentMaterialAccess } from "@/lib/student-content";
import {
  findRecommendationForMaterial,
  isRecommendationSurface,
} from "@/lib/resource-telemetry";

export const runtime = "nodejs";

/** Telemetry bodies are a handful of fields; anything bigger is not ours. */
const MAX_BODY_BYTES = 4 * 1024;

const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * POST /api/student/materials/[materialId]/sessions
 * Open a LearningResourceSession: one row per time a student opens a learning
 * material. Student-only — staff previews are never recorded.
 *
 * Two kinds of open, told apart by `surface`:
 *
 * - Recommendation surfaces (results_recommendation, history_recommendation):
 *   the student opened the recommended pages on one of their quiz results
 *   pages. The attemptId is REQUIRED and must be the student's own; the
 *   material must be one that attempt's stored recommendations actually name.
 *   `recommended`, the page range, class and quiz all come from that verified
 *   snapshot — never from the client — so a session can't be passed off as
 *   recommended, or attached to someone else's attempt. This also keeps
 *   recording a recommendation working after the student leaves the class:
 *   the results page (and its recommendation) remains theirs.
 * - materials_library: the student opened the document in the Course
 *   Materials reader. The library access rule applies (READY and shared with
 *   an enrolled class); any attemptId is ignored.
 *
 * Unverifiable opens are a 404, never a 403, matching the other student
 * material routes. Like simulation telemetry this is research data, gated by
 * consent (docs/plans/consent-compliance-plan.md §9): a non-consenting student
 * gets `sessionId: null` and the client then sends nothing further.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  const [session, { materialId }] = await Promise.all([auth(), params]);
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STUDENT") {
    return NextResponse.json(
      { error: "Only student sessions are recorded" },
      { status: 403 },
    );
  }

  // A real reader opens a handful of materials a minute at most.
  const limited = rateLimit(
    req,
    "resource-session-open",
    60,
    60_000,
    session.user.id,
  );
  if (limited) return limited;

  const parsed = await parseJsonBody(
    resourceSessionCreateSchema,
    req,
    MAX_BODY_BYTES,
  );
  if (!parsed.ok) return parsed.response;

  if (!(await hasResearchConsent(session.user.id))) {
    return NextResponse.json({ sessionId: null });
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!student) return notFound();

  const { surface, attemptId } = parsed.data;

  if (isRecommendationSurface(surface)) {
    if (!attemptId) return notFound();
    const result = await prisma.examResult.findUnique({
      where: { quizAttemptId: attemptId },
      select: {
        quizAttemptId: true,
        studentId: true,
        classId: true,
        quizId: true,
        recommendations: true,
      },
    });
    if (!result || result.studentId !== student.id) return notFound();

    const { items } = parseStoredRecommendations(result.recommendations);
    // Older snapshots name pages, not materials: look up which of their page
    // keys belong to this material.
    const legacyKeys = items.flatMap((item) =>
      item.materialId || !Array.isArray(item.pages)
        ? []
        : item.pages.map((page) => page.storageKey),
    );
    const materialPageKeys = new Set(
      legacyKeys.length > 0
        ? (
            await prisma.materialPage.findMany({
              where: { materialId, storageKey: { in: legacyKeys } },
              select: { storageKey: true },
            })
          ).map((page) => page.storageKey)
        : [],
    );
    const rec = findRecommendationForMaterial(
      items,
      materialId,
      materialPageKeys,
    );
    if (!rec) return notFound();

    const row = await prisma.learningResourceSession.create({
      data: {
        studentId: student.id,
        materialId,
        materialTitle: rec.materialTitle,
        classId: result.classId,
        quizId: result.quizId,
        attemptId: result.quizAttemptId,
        surface,
        recommended: true,
        pageStart: rec.pageRange?.start ?? null,
        pageEnd: rec.pageRange?.end ?? null,
      },
      select: { id: true },
    });
    return NextResponse.json({ sessionId: row.id }, { status: 201 });
  }

  const material = await getStudentMaterialAccess(student.id, materialId);
  if (!material) return notFound();

  const row = await prisma.learningResourceSession.create({
    data: {
      studentId: student.id,
      materialId,
      materialTitle: material.title,
      // A material shared with two of the student's classes has no single
      // class context; leave it null rather than guess.
      classId: material.classIds.length === 1 ? material.classIds[0] : null,
      surface,
      recommended: false,
    },
    select: { id: true },
  });
  return NextResponse.json({ sessionId: row.id }, { status: 201 });
}
