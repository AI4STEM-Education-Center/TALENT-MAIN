// Teacher skill: read the aggregate statistics for the teacher's OWN classes.
//
// Every class-scoped tool starts by resolving the class through
// `ownedClass(ctx, classId)`, which filters on `teacherId` from the session. A
// classId the teacher doesn't own reads as "not found", so the model can't reach
// another teacher's roster by guessing or by following an injected instruction.
//
// The aggregation itself is delegated to `quiz-stats-server.ts` — the same
// functions that back /teacher/stats — so the assistant and the stats pages can
// never disagree about a number. Student emails are deliberately dropped from
// every payload: the teacher can see them in the UI, but there is no reason to
// put them in a model prompt.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  getClassStatsOverview,
  getQuizStats,
  getStudentStats,
} from "@/lib/quiz-stats-server";
import { PASS_THRESHOLD } from "@/lib/quiz-stats";
import type {
  AssistantSkill,
  AssistantTool,
  AssistantToolContext,
} from "../types";

function requireTeacher(ctx: AssistantToolContext): string {
  if (!ctx.teacherId)
    throw new Error("This tool is only available to teachers.");
  return ctx.teacherId;
}

/** The class, but only when this teacher owns it. Null otherwise. */
async function ownedClass(ctx: AssistantToolContext, classId: string) {
  const teacherId = requireTeacher(ctx);
  return prisma.class.findFirst({
    where: { id: classId, teacherId },
    select: { id: true, name: true },
  });
}

const notFound = {
  found: false,
  message: "No class of yours matches that classId.",
} as const;

const listClassesInput = z.object({});

const listClasses: AssistantTool<typeof listClassesInput> = {
  name: "list_classes",
  description:
    "List every class this teacher owns, with its classId, name, enrolled-student count and " +
    "assigned-quiz count. Call this first — the other tools need a classId from here.",
  activityLabel: "Listing your classes",
  input: listClassesInput,
  handler: async (_args, ctx) => {
    const teacherId = requireTeacher(ctx);
    const classes = await prisma.class.findMany({
      where: { teacherId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        _count: { select: { enrollments: true, classQuizzes: true } },
      },
    });
    return {
      classes: classes.map((row) => ({
        classId: row.id,
        name: row.name,
        description: row.description,
        enrolledStudents: row._count.enrollments,
        assignedQuizzes: row._count.classQuizzes,
      })),
    };
  },
};

const classIdInput = z.object({
  classId: z
    .string()
    .min(1)
    .max(64)
    .describe("The classId returned by list_classes."),
});

const getClassOverview: AssistantTool<typeof classIdInput> = {
  name: "get_class_overview",
  description:
    "Statistics overview for one of the teacher's classes: a per-quiz row (attempts, students " +
    "attempted, mean, median, pass rate, average retakes) and a per-student row (quizzes " +
    "completed, average best score, total attempts, last activity). This is the main tool for " +
    "class-level insight questions. Each row carries the quizId / studentId to drill into.",
  activityLabel: "Reading class statistics",
  input: classIdInput,
  handler: async (args, ctx) => {
    const klass = await ownedClass(ctx, args.classId);
    if (!klass) return notFound;

    const overview = await getClassStatsOverview(klass.id);
    return {
      found: true,
      classId: klass.id,
      className: klass.name,
      passThreshold: PASS_THRESHOLD,
      quizzes: overview.quizzes,
      // email/firstName/lastName are dropped: `name` is all the model needs.
      students: overview.students.map((student) => ({
        studentId: student.studentId,
        name: student.name,
        quizzesCompleted: student.quizzesCompleted,
        avgBestScore: student.avgBestScore,
        totalAttempts: student.totalAttempts,
        lastActivity: student.lastActivity?.toISOString() ?? null,
      })),
    };
  },
};

const quizStatsInput = classIdInput.extend({
  quizId: z
    .string()
    .min(1)
    .max(64)
    .describe("The quizId from get_class_overview's quizzes list."),
});

const getQuizBreakdown: AssistantTool<typeof quizStatsInput> = {
  name: "get_quiz_breakdown",
  description:
    "Deep statistics for ONE quiz in one of the teacher's classes: score distribution buckets, " +
    "mean/median/min/max, pass rate, average attempts, and the per-question correctness rate. The " +
    "per-question rates are the best evidence for which concepts the class struggled with.",
  activityLabel: "Analyzing a quiz",
  input: quizStatsInput,
  handler: async (args, ctx) => {
    const klass = await ownedClass(ctx, args.classId);
    if (!klass) return notFound;

    // Scoped to (classId, quizId): a quizId from another class returns null
    // rather than that class's numbers.
    const stats = await getQuizStats(klass.id, args.quizId);
    if (!stats) return { found: false, message: "That quiz no longer exists." };

    return {
      found: true,
      className: klass.name,
      passThreshold: PASS_THRESHOLD,
      quizId: stats.quizId,
      quizName: stats.quizName,
      attemptsTotal: stats.attemptsTotal,
      studentsAttempted: stats.studentsAttempted,
      mean: stats.mean,
      median: stats.median,
      min: stats.min,
      max: stats.max,
      passRate: stats.passRate,
      avgAttemptsPerStudent: stats.avgAttemptsPerStudent,
      distribution: stats.distribution,
      questionStats: stats.questionStats.map((question) => ({
        text: question.text,
        answered: question.total,
        correct: question.correct,
        correctRate: Math.round(question.rate * 1000) / 1000,
      })),
    };
  },
};

const studentStatsInput = classIdInput.extend({
  studentId: z
    .string()
    .min(1)
    .max(64)
    .describe("The studentId from get_class_overview's students list."),
});

const getStudentBreakdown: AssistantTool<typeof studentStatsInput> = {
  name: "get_student_breakdown",
  description:
    "Cross-quiz statistics for ONE student in one of the teacher's classes: quizzes assigned vs " +
    "completed, overall and average-best scores, retake counts, last activity, a per-quiz " +
    "breakdown, and the list of completed attempts with dates.",
  activityLabel: "Reading a student's record",
  input: studentStatsInput,
  handler: async (args, ctx) => {
    const klass = await ownedClass(ctx, args.classId);
    if (!klass) return notFound;

    // Enrollment is checked separately: ownership of the class does not imply
    // the studentId belongs to it, and getStudentStats filters by (classId,
    // studentId) but would happily report an all-zero row for an outsider.
    const enrollment = await prisma.classEnrollment.findUnique({
      where: {
        classId_studentId: { classId: klass.id, studentId: args.studentId },
      },
      select: { id: true },
    });
    if (!enrollment) {
      return {
        found: false,
        message: "That student is not enrolled in that class.",
      };
    }

    const stats = await getStudentStats(klass.id, args.studentId);
    if (!stats)
      return { found: false, message: "That student no longer exists." };

    return {
      found: true,
      className: klass.name,
      passThreshold: PASS_THRESHOLD,
      ...stats,
      lastActivity: stats.lastActivity?.toISOString() ?? null,
      attempts: stats.attempts.map((attempt) => ({
        quizName: attempt.quizName,
        score: attempt.score,
        completedAt: attempt.completedAt.toISOString(),
      })),
    };
  },
};

const strugglingInput = z.object({
  classId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Restrict to one class. Omit to scan every class the teacher owns.",
    ),
  maxAvgScore: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      `Flag students whose average best score is below this (default ${PASS_THRESHOLD}).`,
    ),
  includeInactive: z
    .boolean()
    .optional()
    .describe(
      "Also flag enrolled students who have not completed any quiz yet. Default true.",
    ),
});

const findStrugglingStudents: AssistantTool<typeof strugglingInput> = {
  name: "find_struggling_students",
  description:
    "Scan one class or every class the teacher owns and return the students whose average best " +
    "score is below a threshold, plus (optionally) the enrolled students who have not completed " +
    "any quiz. Use this for 'who needs help' questions instead of pulling every class overview.",
  activityLabel: "Looking for students who need help",
  input: strugglingInput,
  handler: async (args, ctx) => {
    const teacherId = requireTeacher(ctx);
    const threshold = args.maxAvgScore ?? PASS_THRESHOLD;
    const includeInactive = args.includeInactive ?? true;

    const classes = await prisma.class.findMany({
      where: { teacherId, ...(args.classId ? { id: args.classId } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    });
    if (classes.length === 0) {
      return args.classId ? notFound : { found: true, threshold, classes: [] };
    }

    const perClass = await Promise.all(
      classes.map(async (klass) => {
        const overview = await getClassStatsOverview(klass.id);
        const flagged = overview.students.filter((student) =>
          student.quizzesCompleted === 0
            ? includeInactive
            : student.avgBestScore < threshold,
        );
        return {
          classId: klass.id,
          className: klass.name,
          enrolledStudents: overview.students.length,
          flaggedStudents: flagged.map((student) => ({
            studentId: student.studentId,
            name: student.name,
            quizzesCompleted: student.quizzesCompleted,
            avgBestScore: student.avgBestScore,
            totalAttempts: student.totalAttempts,
            lastActivity: student.lastActivity?.toISOString() ?? null,
            reason:
              student.quizzesCompleted === 0
                ? "no completed quizzes"
                : "below threshold",
          })),
        };
      }),
    );

    return { found: true, threshold, includeInactive, classes: perClass };
  },
};

export const teacherClassInsightsSkill: AssistantSkill = {
  id: "teacher-class-insights",
  name: "Class insights",
  description:
    "Lets a teacher ask for insight across their classes: class and quiz statistics, per-question " +
    "correctness rates, individual student records, and who is falling behind.",
  audience: "teacher",
  instructions: [
    "You can read statistics for the teacher's own classes with list_classes, get_class_overview, " +
      "get_quiz_breakdown, get_student_breakdown, and find_struggling_students.",
    "Always start from list_classes unless the teacher's message already pins down one class you " +
      "have a classId for. Ask which class they mean rather than guessing when they own several.",
    "Ground every claim in numbers a tool returned, and say which quiz or student they came from. " +
      "Never estimate a statistic you did not fetch.",
    "For insight questions, go past restating the numbers: point at the specific quizzes and " +
      "questions with the lowest correctness rates, name the students who need attention, and " +
      "suggest a concrete next step. Note when a sample is too small to conclude anything.",
    "These tools only expose classes this teacher owns. If they ask about another teacher's class " +
      "or a school-wide figure, say that is outside what you can see.",
    "Student data here is confidential to this teacher. Discuss it with them freely, but never " +
      "suggest sharing one student's scores with another student.",
  ].join("\n"),
  tools: [
    listClasses,
    getClassOverview,
    getQuizBreakdown,
    getStudentBreakdown,
    findStrugglingStudents,
  ],
};
