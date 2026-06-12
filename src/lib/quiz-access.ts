import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Ownership convention (mirrors prisma/schema.prisma): Quiz.teacherId/Topic.teacherId
// NULL = global pool (admin-managed), non-null = private to that teacher.

export type ContentActor =
  | { role: "TEACHER"; teacherId: string; userId: string }
  | { role: "ADMIN"; teacherId: null; userId: string };

/**
 * Resolve the session into a content actor: a teacher (with their Teacher row)
 * or an admin (who manages the global pool). Returns null for students,
 * anonymous users, and TEACHER users missing their Teacher row.
 */
export async function getContentActor(): Promise<ContentActor | null> {
  const session = await auth();
  if (!session?.user) return null;
  if (session.user.role === "ADMIN") {
    return { role: "ADMIN", teacherId: null, userId: session.user.id };
  }
  if (session.user.role !== "TEACHER") return null;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return null;
  return { role: "TEACHER", teacherId: teacher.id, userId: session.user.id };
}

/** The teacherId an actor's own content carries (null = the global pool). */
export function ownScope(actor: ContentActor): string | null {
  return actor.teacherId;
}

/** Can the actor edit/delete this content? Teachers manage their own, admins manage the pool. */
export function canManage(actor: ContentActor, content: { teacherId: string | null }): boolean {
  return content.teacherId === actor.teacherId;
}

/** Can the actor view this content? Own content, plus the pool is readable by everyone. */
export function canRead(actor: ContentActor, content: { teacherId: string | null }): boolean {
  return content.teacherId === null || content.teacherId === actor.teacherId;
}

/**
 * Deep-copy a quiz (questions + options included) into a target scope.
 * Used for both directions — admin promoting a teacher quiz into the pool, and
 * a teacher importing a pool quiz — so the copy is fully independent: edits or
 * deletions on either side never affect the other.
 *
 * The source quiz's topic (if any) is matched by name within the target scope,
 * or created there, so grouping carries over without sharing Topic rows.
 */
export async function deepCopyQuiz(sourceQuizId: string, targetTeacherId: string | null) {
  const source = await prisma.quiz.findUnique({
    where: { id: sourceQuizId },
    include: {
      topic: true,
      questions: { include: { options: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!source) return null;

  return prisma.$transaction(async (tx) => {
    let topicId: string | null = null;
    if (source.topic) {
      const existing = await tx.topic.findFirst({
        where: { teacherId: targetTeacherId, name: source.topic.name },
      });
      const topic =
        existing ??
        (await tx.topic.create({
          data: { name: source.topic.name, order: source.topic.order, teacherId: targetTeacherId },
        }));
      topicId = topic.id;
    }

    const quiz = await tx.quiz.create({
      data: {
        name: source.name,
        order: source.order,
        topicId,
        teacherId: targetTeacherId,
        sourceQuizId: source.id,
      },
    });

    for (const question of source.questions) {
      await tx.question.create({
        data: {
          quizId: quiz.id,
          title: question.title,
          text: question.text,
          difficultyLevel: question.difficultyLevel,
          answerMode: question.answerMode,
          points: question.points,
          feedbackGeneral: question.feedbackGeneral,
          feedbackCorrect: question.feedbackCorrect,
          feedbackIncorrect: question.feedbackIncorrect,
          sourceQuestionId: question.sourceQuestionId,
          createdById: targetTeacherId,
          // NUMERIC grading data — without these, a copied numeric question
          // would lose its correct answer and silently grade as wrong.
          answerNumeric: question.answerNumeric,
          answerTolerance: question.answerTolerance,
          answerUnit: question.answerUnit,
          // Figure reference. The S3 object is intentionally shared between
          // copies — figures are immutable, so pointing at the same key is safe.
          figureStorageKey: question.figureStorageKey,
          figureBucket: question.figureBucket,
          figureAlt: question.figureAlt,
          options: {
            // Image answer-choices carry their (immutable, shared) crop key too.
            create: question.options.map((o) => ({
              text: o.text,
              isCorrect: o.isCorrect,
              imageStorageKey: o.imageStorageKey,
              imageBucket: o.imageBucket,
              imageAlt: o.imageAlt,
            })),
          },
        },
      });
    }

    return tx.quiz.findUniqueOrThrow({
      where: { id: quiz.id },
      include: { topic: true, _count: { select: { questions: true } } },
    });
  });
}
