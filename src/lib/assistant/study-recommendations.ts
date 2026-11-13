// Student-wide discovery uses bounded recent results; card hydration always
// resolves ownership and current enrollment again, never trusts model ids.
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseReviewSnapshot } from "@/lib/exam-results";
import { getStudentKnowledgeProfile } from "@/lib/knowledge-tracing";
import {
  coachActionRefSchema,
  findPracticeOffer,
  hydrateCoachAction,
  loadCoachCandidates,
  loadSimulationOptions,
  resolveCoachScope,
  simulationActionView,
} from "./coach";
import type { CoachActionView, CoachScope } from "./coach-types";

export const studyActionRefSchema = z.object({
  source: z.literal("study"),
  resultId: z.string().min(1).max(64).optional(),
  questionNumber: z.number().int().min(1).max(500).optional(),
  ref: coachActionRefSchema,
});
export type StudyActionRef = z.infer<typeof studyActionRefSchema>;

async function enrolledClasses(studentId: string) {
  return prisma.class.findMany({
    where: { disabledAt: null, enrollments: { some: { studentId } } },
    select: { id: true },
  });
}

// Materials belong to an entire result, including a fully correct result.
// This scope never grants an answer key or sends a snapshot to the model.
async function resultScope(
  studentId: string,
  resultId: string,
): Promise<CoachScope | null> {
  const classes = await enrolledClasses(studentId);
  const result = await prisma.examResult.findFirst({
    where: {
      quizAttemptId: resultId,
      studentId,
      classId: { in: classes.map((c) => c.id) },
    },
    select: {
      quizAttemptId: true,
      classId: true,
      quizId: true,
      quizName: true,
      topicName: true,
      className: true,
      reviewSnapshot: true,
      practiceVersionName: true,
    },
  });
  if (!result) return null;
  return {
    ...result,
    studentId,
    resultId,
    questionNumber: 1,
    questionId: null,
    question: parseReviewSnapshot(result.reviewSnapshot).questions[0] ?? {},
    alternativeVersionName: result.practiceVersionName,
    ownVersionId: null,
    answerKeyAvailable: false,
  };
}

export async function hydrateStudyAction(
  raw: unknown,
  studentId: string,
): Promise<CoachActionView | null> {
  const parsed = studyActionRefSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { ref, resultId, questionNumber } = parsed.data;
  if (ref.kind === "simulation") {
    const [sim] = await loadSimulationOptions(
      { studentId },
      [ref.simulationId],
      null,
    );
    // Exclude paused classes in addition to the content route's enrollment rule.
    const classes = await enrolledClasses(studentId);
    const assignment = await prisma.classQuiz.findFirst({
      where: {
        classId: { in: classes.map((c) => c.id) },
        quiz: { questions: { some: { simulation: { id: ref.simulationId } } } },
      },
      select: { quizId: true },
    });
    return sim && assignment ? simulationActionView(ref, sim) : null;
  }
  if (!resultId) return null;
  const base = await resultScope(studentId, resultId);
  if (!base) return null;
  if (ref.kind === "material") return hydrateCoachAction(ref, base);
  if (!questionNumber) return null;
  const scope = await resolveCoachScope(studentId, resultId, questionNumber);
  if (!scope) return null;
  const view = await hydrateCoachAction(ref, scope);
  return view?.kind === "practice"
    ? { ...view, target: { attemptId: resultId, questionNumber } }
    : null;
}

export async function hydrateStudyActions(
  raw: unknown[] | undefined,
  studentId: string,
) {
  const views = await Promise.all(
    (raw ?? []).map((ref) => hydrateStudyAction(ref, studentId)),
  );
  return views.filter((view): view is CoachActionView => view !== null);
}

export async function findStudyCandidates(studentId: string, topic?: string) {
  const classes = await enrolledClasses(studentId);
  const classIds = classes.map((c) => c.id);
  const [results, simulations, profile] = await Promise.all([
    prisma.examResult.findMany({
      where: { studentId, classId: { in: classIds } },
      orderBy: { completedAt: "desc" },
      take: 20,
      select: {
        quizAttemptId: true,
        topicName: true,
        quizName: true,
        reviewSnapshot: true,
      },
    }),
    prisma.questionSimulation.findMany({
      where: {
        status: "READY",
        question: {
          quiz: { classQuizzes: { some: { classId: { in: classIds } } } },
        },
      },
      select: { id: true },
      take: 100,
      orderBy: { id: "asc" },
    }),
    getStudentKnowledgeProfile(studentId, { allowedClassIds: classIds }),
  ]);
  const candidates: Array<{
    action: StudyActionRef;
    title: string;
    topic: string;
    description?: string | null;
    priority: number;
    /** Used only server-side for matching; never return the original question. */
    searchText?: string;
  }> = [];
  const weak = (profile?.unknownConcepts ?? []).filter(
    (c) => !c.classId || classIds.includes(c.classId),
  );
  const rank = (text: string) =>
    weak.reduce(
      (score, c) =>
        score +
        ([c.concept, c.topic].some(
          (term) => term && text.toLowerCase().includes(term.toLowerCase()),
        )
          ? 1
          : 0),
      0,
    );
  let practiceLookups = 0;
  for (const result of results) {
    const base = await resultScope(studentId, result.quizAttemptId);
    if (!base) continue;
    const options = await loadCoachCandidates(base);
    for (const material of options.materials)
      candidates.push({
        action: {
          source: "study",
          resultId: base.resultId,
          ref: {
            kind: "material",
            recommendationIndex: material.recommendationIndex,
            reason: "Review this concept.",
          },
        },
        title: material.title,
        topic: result.topicName,
        description: `${material.pages}: ${material.reason}`,
        priority: rank(
          `${result.topicName} ${material.title} ${material.reason}`,
        ),
      });
    const questions = parseReviewSnapshot(result.reviewSnapshot).questions;
    for (const [index, question] of questions.entries()) {
      // Bound database work even for unusually large result snapshots.
      if (question.isCorrect !== false || practiceLookups >= 40) continue;
      practiceLookups += 1;
      const scope = await resolveCoachScope(
        studentId,
        base.resultId,
        index + 1,
      );
      if (!scope) continue;
      const practice = await findPracticeOffer(scope);
      if (practice)
        candidates.push({
          action: {
            source: "study",
            resultId: base.resultId,
            questionNumber: index + 1,
            ref: {
              kind: "practice",
              ...practice,
              reason: "Try a similar question.",
            },
          },
          title: `${result.quizName} · Question ${index + 1}`,
          topic: result.topicName,
          searchText: question.text,
          priority: rank(`${result.topicName} ${question.text ?? ""}`),
        });
    }
  }
  const sims = await loadSimulationOptions(
    { studentId },
    simulations.map((s) => s.id),
    null,
  );
  for (const sim of sims)
    candidates.push({
      action: {
        source: "study",
        ref: {
          kind: "simulation",
          simulationId: sim.simulationId,
          goal: "Explore this concept.",
          steps: ["Open the simulation."],
          observe: "Watch how the model changes.",
        },
      },
      title: sim.title,
      topic: sim.topic ?? "",
      description: [sim.learningGoal, sim.description]
        .filter(Boolean)
        .join("\n"),
      priority: rank(`${sim.title} ${sim.topic} ${sim.learningGoal}`),
    });
  return candidates
    .filter(
      (c) =>
        !topic ||
        `${c.title} ${c.topic} ${c.description ?? ""} ${c.searchText ?? ""}`
          .toLowerCase()
          .includes(topic.toLowerCase()),
    )
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 30)
    .map(({ searchText: _searchText, ...candidate }) => candidate);
}
