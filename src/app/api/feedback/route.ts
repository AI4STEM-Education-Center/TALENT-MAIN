import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";
import { contentFeedbackSubmitSchema, parseBody } from "@/lib/validation";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { parseStoredRecommendations } from "@/lib/exam-results";
import {
  feedbackSubjectKey,
  type FeedbackAudience,
} from "@/lib/content-feedback";

export const runtime = "nodejs";

/** Casefold + collapse whitespace, for matching a material title snapshot. */
const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, " ");

/** The row context a resolved-and-authorized submission carries. */
type FeedbackContext = {
  audience: FeedbackAudience;
  routedTeacherId: string | null;
  attemptId: string | null;
  classId: string | null;
  className: string | null;
  quizId: string | null;
  quizName: string | null;
};

/**
 * POST /api/feedback
 *
 * A 5-point rating plus a written explanation on one piece of AI content.
 * Two surfaces, one row shape (see ContentFeedback in prisma/schema.prisma):
 *
 *  - STUDENT — on a learning material or simulation recommended after a quiz.
 *    `attemptId` is required and must be the student's own attempt, AND the
 *    subject must actually appear in that attempt's stored recommendations.
 *    Verifying membership (rather than just "this simulation exists") is what
 *    stops a student spraying ratings at content they were never shown, which
 *    would quietly poison the averages a teacher reads.
 *
 *  - TEACHER — on a simulation generated for them. Authorized with the same
 *    canManage() check as the revision-feedback route, so a teacher rates
 *    simulations on their own quizzes and an admin those in the pool.
 *
 * Re-submitting REPLACES the author's previous verdict on the same subject
 * (unique on authorUserId + subjectKey) rather than stacking a second one.
 *
 * Not consent-gated: this is product-quality feedback about generated content,
 * like GuardrailFeedback, not the engagement telemetry that §9 of the consent
 * plan covers (SimulationSession). Nothing here records what a student did.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(
    req,
    "content-feedback",
    30,
    60_000,
    session.user.id,
  );
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBody(contentFeedbackSubmitSchema, raw);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  try {
    // Three paths, because "who may rate this" differs by surface:
    //   student  → their own attempt's recommendations
    //   staff + attemptId → the recommendations shown on a student's stats
    //                       page, for a class they own
    //   staff, no attemptId → a simulation in the quiz editor
    const context =
      session.user.role === "STUDENT"
        ? await resolveStudentContext(session.user.id, input)
        : input.attemptId
          ? await resolveStaffAttemptContext(input)
          : await resolveStaffSimulationContext(input);
    if ("error" in context) return context.error;

    const author = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { firstName: true, lastName: true, email: true, role: true },
    });

    const subjectKey = feedbackSubjectKey({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      attemptId: context.attemptId,
    });

    const shared = {
      audience: context.audience,
      subjectType: input.subjectType,
      rating: input.rating,
      comment: input.comment,
      authorName: author
        ? `${author.firstName} ${author.lastName}`.trim() || null
        : null,
      authorEmail: author?.email ?? null,
      authorRole: author?.role ?? session.user.role ?? "STUDENT",
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      subjectDetail: input.subjectDetail,
      routedTeacherId: context.routedTeacherId,
      attemptId: context.attemptId,
      quizId: context.quizId,
      quizName: context.quizName,
      classId: context.classId,
      className: context.className,
    };

    const row = await prisma.contentFeedback.upsert({
      where: {
        authorUserId_subjectKey: {
          authorUserId: session.user.id,
          subjectKey,
        },
      },
      create: { ...shared, authorUserId: session.user.id, subjectKey },
      update: shared,
      select: { id: true, rating: true, comment: true, subjectKey: true },
    });

    return NextResponse.json({ feedback: row }, { status: 201 });
  } catch (error) {
    logApiError("CONTENT_FEEDBACK_POST", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

type Resolution = FeedbackContext | { error: NextResponse };

const notFound = () => ({
  error: NextResponse.json({ error: "Not found" }, { status: 404 }),
});

type SubmitInput = {
  subjectType: "MATERIAL" | "SIMULATION";
  subjectId: string | null;
  subjectLabel: string;
  attemptId: string | null;
};

/**
 * Student surface: the attempt must be theirs and the subject must be one of
 * the recommendations that attempt's results actually surfaced. Context comes
 * off the ExamResult, which is the durable snapshot — so a verdict still
 * carries its class and quiz name after either row is renamed or deleted.
 */
async function resolveStudentContext(
  userId: string,
  input: SubmitInput,
): Promise<Resolution> {
  if (!input.attemptId) {
    return {
      error: NextResponse.json(
        { error: "attemptId is required" },
        { status: 400 },
      ),
    };
  }

  const student = await prisma.student.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!student) return notFound();

  const result = await readAttemptResult(input.attemptId);
  if (!result || result.studentId !== student.id) return notFound();
  if (!isRecommendedByAttempt(result.recommendations, input)) {
    return notRecommended();
  }

  // Route to the teacher who owns the class, so the verdict lands in their
  // panel. A deleted class leaves the row admin-only rather than unreachable.
  const cls = await prisma.class.findUnique({
    where: { id: result.classId },
    select: { teacherId: true },
  });

  return {
    audience: "STUDENT",
    routedTeacherId: cls?.teacherId ?? null,
    attemptId: input.attemptId,
    classId: result.classId,
    className: result.className,
    quizId: result.quizId,
    quizName: result.quizName,
  };
}

/** The durable snapshot a rating's context and authorization both come from. */
function readAttemptResult(attemptId: string) {
  return prisma.examResult.findUnique({
    where: { quizAttemptId: attemptId },
    select: {
      studentId: true,
      classId: true,
      className: true,
      quizId: true,
      quizName: true,
      recommendations: true,
    },
  });
}

const notRecommended = () => ({
  error: NextResponse.json(
    { error: "That is not one of this attempt's recommendations" },
    { status: 404 },
  ),
});

/**
 * Whether the subject is one this attempt's results actually surfaced.
 *
 * Checking membership rather than mere existence is what stops anyone spraying
 * ratings at content that was never shown, which would quietly poison the
 * averages the panel reports. Simulations are matched by id (the rail always
 * has one); materials reach the results page as a title snapshot with no row
 * behind them, so their identity is the normalized title — the same fallback
 * feedbackSubjectKey uses.
 */
function isRecommendedByAttempt(
  recommendations: string | null,
  input: SubmitInput,
): boolean {
  const stored = parseStoredRecommendations(recommendations);
  return input.subjectType === "SIMULATION"
    ? !!input.subjectId &&
        (stored.simulations ?? []).some(
          (sim) => sim.simulationId === input.subjectId,
        )
    : stored.items.some(
        (item) =>
          normalize(item.materialTitle) === normalize(input.subjectLabel),
      );
}

/**
 * Staff verdict on a recommendation shown on a student's stats page — the
 * teacher's read-only copy of the same material cards and simulation rail the
 * student saw (see TeacherAttemptResources).
 *
 * A teacher rates attempts in classes they OWN; an admin, who has no class of
 * their own, may rate any. Both land as TEACHER-audience rows carrying the
 * attempt's class/quiz context, so the panel can show a student's verdict and
 * their teacher's on the same recommendation side by side.
 */
async function resolveStaffAttemptContext(
  input: SubmitInput,
): Promise<Resolution> {
  const actor = await getContentActor();
  if (!actor) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  const result = await readAttemptResult(input.attemptId!);
  if (!result) return notFound();

  // Ownership: the attempt's class must be this teacher's. Admins are exempt
  // (they own no classes) and read/rate across the whole site.
  if (actor.role === "TEACHER") {
    const owned = await prisma.class.findFirst({
      where: { id: result.classId, teacherId: actor.teacherId },
      select: { id: true },
    });
    if (!owned) return notFound();
  }

  if (!isRecommendedByAttempt(result.recommendations, input)) {
    return notRecommended();
  }

  return {
    audience: "TEACHER",
    routedTeacherId: actor.teacherId,
    attemptId: input.attemptId,
    classId: result.classId,
    className: result.className,
    quizId: result.quizId,
    quizName: result.quizName,
  };
}

/**
 * Staff verdict on a simulation outside any attempt — the quiz editor's
 * simulation panel. Authorized with the same canManage() check as the
 * revision-feedback route, so a teacher rates simulations on their own
 * quizzes and an admin those in the pool. Materials are rejected here: a
 * material only exists as a recommendation, so rating one without an attempt
 * would have no subject to point at.
 */
async function resolveStaffSimulationContext(
  input: SubmitInput,
): Promise<Resolution> {
  if (input.subjectType !== "SIMULATION") {
    return {
      error: NextResponse.json(
        { error: "Rating a material requires the attempt that recommended it" },
        { status: 400 },
      ),
    };
  }
  if (!input.subjectId) {
    return {
      error: NextResponse.json(
        { error: "subjectId is required" },
        { status: 400 },
      ),
    };
  }

  const actor = await getContentActor();
  if (!actor) {
    return {
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  const sim = await prisma.questionSimulation.findUnique({
    where: { id: input.subjectId },
    select: {
      question: {
        select: { quiz: { select: { id: true, name: true, teacherId: true } } },
      },
    },
  });
  if (!sim || !canManage(actor, sim.question.quiz)) return notFound();

  return {
    audience: "TEACHER",
    routedTeacherId: actor.teacherId,
    attemptId: null,
    classId: null,
    className: null,
    quizId: sim.question.quiz.id,
    quizName: sim.question.quiz.name,
  };
}
