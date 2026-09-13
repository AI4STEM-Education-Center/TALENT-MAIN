// Student skill: search and interpret the student's OWN past quiz results.
//
// Every query is anchored on `ctx.studentId`, which the API route derives from
// the session — no tool takes a student id, so there is no argument the model
// (or a prompt-injected attachment) could set to read someone else's results.
//
// Results are read from ExamResult, the durable per-attempt snapshot, rather
// than the live quiz rows: a teacher editing or deleting a quiz must not change
// what the student sees here (see prisma/schema.prisma).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseReviewSnapshot } from "@/lib/exam-results";
import { mean, max as maxOf, min as minOf, PASS_THRESHOLD } from "@/lib/quiz-stats";
import { canAttemptAgain } from "@/lib/quiz-availability";
import type { AssistantSkill, AssistantTool, AssistantToolContext } from "../types";

/** Hard ceiling on rows any single search returns, whatever the model asks for. */
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 20;

function requireStudent(ctx: AssistantToolContext): string {
  if (!ctx.studentId) throw new Error("This tool is only available to students.");
  return ctx.studentId;
}

/** Case-insensitive substring match, done in JS so it behaves the same on any datasource. */
function matches(haystack: string, needle: string | undefined): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

const searchInput = z.object({
  quizName: z
    .string()
    .max(200)
    .optional()
    .describe("Case-insensitive substring of the quiz name. Omit to match every quiz."),
  topic: z
    .string()
    .max(200)
    .optional()
    .describe("Case-insensitive substring of the topic name. Omit to match every topic."),
  className: z
    .string()
    .max(200)
    .optional()
    .describe("Case-insensitive substring of the class name. Omit to match every class."),
  minScore: z.number().min(0).max(100).optional().describe("Only results scoring at least this percentage."),
  maxScore: z.number().min(0).max(100).optional().describe("Only results scoring at most this percentage."),
  completedAfter: z
    .string()
    .max(40)
    .optional()
    .describe("ISO-8601 date or datetime; only results completed on or after it."),
  completedBefore: z
    .string()
    .max(40)
    .optional()
    .describe("ISO-8601 date or datetime; only results completed on or before it."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`Maximum results to return (default ${DEFAULT_SEARCH_LIMIT}, hard cap ${MAX_SEARCH_LIMIT}).`),
});

/** Parse an ISO date the model supplied; invalid input is ignored rather than fatal. */
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

const searchQuizResults: AssistantTool<typeof searchInput> = {
  name: "search_quiz_results",
  description:
    "Search the student's own completed quiz results. Every filter is optional and they combine " +
    "with AND — call it with no arguments to list all results newest-first. Returns one row per " +
    "completed attempt with its resultId, quiz, topic, class, score and completion date. Use the " +
    "returned resultId with get_quiz_result_detail to look at a single attempt question by question.",
  activityLabel: "Searching your quiz results",
  input: searchInput,
  handler: async (args, ctx) => {
    const studentId = requireStudent(ctx);
    const after = parseDate(args.completedAfter);
    const before = parseDate(args.completedBefore);
    const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;

    const rows = await prisma.examResult.findMany({
      where: {
        studentId,
        ...(after || before
          ? {
              completedAt: {
                ...(after ? { gte: after } : {}),
                ...(before ? { lte: before } : {}),
              },
            }
          : {}),
        ...(args.minScore !== undefined || args.maxScore !== undefined
          ? {
              score: {
                ...(args.minScore !== undefined ? { gte: args.minScore } : {}),
                ...(args.maxScore !== undefined ? { lte: args.maxScore } : {}),
              },
            }
          : {}),
      },
      orderBy: { completedAt: "desc" },
      select: {
        quizAttemptId: true,
        quizName: true,
        topicName: true,
        className: true,
        score: true,
        correctCount: true,
        totalCount: true,
        completedAt: true,
      },
    });

    const filtered = rows.filter(
      (row) =>
        matches(row.quizName, args.quizName) &&
        matches(row.topicName, args.topic) &&
        matches(row.className, args.className)
    );

    return {
      totalMatches: filtered.length,
      returned: Math.min(filtered.length, limit),
      results: filtered.slice(0, limit).map((row) => ({
        resultId: row.quizAttemptId,
        quizName: row.quizName,
        topic: row.topicName || null,
        className: row.className,
        score: row.score,
        correctCount: row.correctCount,
        totalCount: row.totalCount,
        completedAt: row.completedAt.toISOString(),
      })),
    };
  },
};

const detailInput = z.object({
  resultId: z.string().min(1).max(64).describe("The resultId returned by search_quiz_results."),
});

/**
 * Can this student still submit another graded answer for the quiz an archived
 * result belongs to? This is what decides whether the tool may show the answer
 * key, so it errs toward "yes" (withhold) in every ambiguous case.
 */
async function retakeStillPossible(
  studentId: string,
  classId: string,
  quizId: string
): Promise<boolean> {
  const [classQuiz, completedAttempts, inProgress] = await Promise.all([
    prisma.classQuiz.findUnique({
      where: { classId_quizId: { classId, quizId } },
      select: { published: true, availableFrom: true, availableUntil: true, maxAttempts: true },
    }),
    prisma.quizAttempt.count({
      where: { studentId, classId, quizId, completedAt: { not: null } },
    }),
    prisma.quizAttempt.count({ where: { studentId, classId, quizId, completedAt: null } }),
  ]);

  // No ClassQuiz row: the quiz was removed from the class (or deleted outright),
  // so nothing further can be submitted and the attempt is final.
  if (!classQuiz) return false;
  // Unpublished is a teacher hiding a quiz, not retiring it — one click brings it
  // back, so treat the attempt as still open.
  if (!classQuiz.published) return true;

  return canAttemptAgain(
    {
      availableFrom: classQuiz.availableFrom,
      availableUntil: classQuiz.availableUntil,
      maxAttempts: classQuiz.maxAttempts,
    },
    { completedAttempts, hasAttemptInProgress: inProgress > 0 }
  );
}

const getQuizResultDetail: AssistantTool<typeof detailInput> = {
  name: "get_quiz_result_detail",
  description:
    "Detail for ONE of the student's own completed attempts: score, the AI summary generated for " +
    "it, and every question with the answer the student gave. Call search_quiz_results first to " +
    "get a resultId. The answer key is included ONLY when the attempt is final — no attempt is " +
    "in progress and the student can no longer retake the quiz. While a retake is still possible " +
    "the response sets answerKeyWithheld and omits both the correct answers and the per-question " +
    "correct/incorrect flags, because revealing them would hand the student the answers to a " +
    "quiz they can still submit.",
  activityLabel: "Reading a past result",
  input: detailInput,
  handler: async (args, ctx) => {
    const studentId = requireStudent(ctx);
    const row = await prisma.examResult.findUnique({
      where: { quizAttemptId: args.resultId },
    });
    // Ownership is re-checked here, not just in the caller: a fabricated
    // resultId must read as "not found", never as another student's attempt.
    if (!row || row.studentId !== studentId) {
      return { found: false, message: "No result of yours matches that resultId." };
    }

    const snapshot = parseReviewSnapshot(row.reviewSnapshot);
    const retakeable = await retakeStillPossible(studentId, row.classId, row.quizId);

    return {
      found: true,
      resultId: row.quizAttemptId,
      quizName: row.quizName,
      topic: row.topicName || null,
      className: row.className,
      score: row.score,
      correctCount: row.correctCount,
      totalCount: row.totalCount,
      completedAt: row.completedAt.toISOString(),
      summary: row.summary,
      attemptState: retakeable ? "retake_possible" : "final",
      // Present and true only in the withholding case, so the model reads it as
      // a fact about this response rather than a flag it has to interpret.
      ...(retakeable
        ? {
            answerKeyWithheld: true,
            answerKeyWithheldReason:
              "The student can still attempt this quiz again, so the correct answers and the " +
              "per-question correct/incorrect marks are not available to you. Help them reason " +
              "about the questions instead, and do not guess or state which answer is right.",
          }
        : {}),
      questions: snapshot.questions.map((question, index) => {
        const yourAnswer =
          question.answerMode === "NUMERIC"
            ? question.submittedNumeric ?? null
            : question.options.filter((o) => o.selected).map((o) => o.text);

        // While a retake is possible the student gets back only what they
        // themselves submitted. `isCorrect` is withheld along with the key: on a
        // two-option or short-list question, "you were wrong" IS the answer.
        if (retakeable) {
          return {
            number: index + 1,
            text: question.text,
            yourAnswer,
            ...(question.unit ? { unit: question.unit } : {}),
          };
        }

        return {
          number: index + 1,
          text: question.text,
          isCorrect: question.isCorrect,
          yourAnswer,
          correctAnswer:
            question.answerMode === "NUMERIC"
              ? question.correctNumeric ?? null
              : question.options.filter((o) => o.isCorrect).map((o) => o.text),
          ...(question.unit ? { unit: question.unit } : {}),
        };
      }),
    };
  },
};

const trendInput = z.object({
  groupBy: z
    .enum(["topic", "quiz", "class"])
    .describe("Which dimension to aggregate the student's results over."),
  topic: z.string().max(200).optional().describe("Optional case-insensitive topic-name filter applied first."),
  className: z.string().max(200).optional().describe("Optional case-insensitive class-name filter applied first."),
});

const summarizePerformance: AssistantTool<typeof trendInput> = {
  name: "summarize_performance",
  description:
    "Aggregate the student's own completed results by topic, quiz, or class: attempt count, mean " +
    "score, best and worst score, and how many attempts were passing. Use this instead of " +
    "listing every result when the student asks how they are doing overall or in one area.",
  activityLabel: "Summarizing your performance",
  input: trendInput,
  handler: async (args, ctx) => {
    const studentId = requireStudent(ctx);
    const rows = await prisma.examResult.findMany({
      where: { studentId },
      orderBy: { completedAt: "desc" },
      select: {
        quizName: true,
        topicName: true,
        className: true,
        score: true,
        completedAt: true,
      },
    });

    const filtered = rows.filter(
      (row) => matches(row.topicName, args.topic) && matches(row.className, args.className)
    );

    const keyOf = (row: (typeof filtered)[number]): string =>
      args.groupBy === "topic"
        ? row.topicName || "No topic"
        : args.groupBy === "quiz"
          ? row.quizName
          : row.className;

    const groups = new Map<string, { scores: number[]; latest: Date }>();
    for (const row of filtered) {
      const key = keyOf(row);
      const group = groups.get(key);
      if (group) {
        group.scores.push(row.score);
        // Rows arrive newest-first, so the first one seen is already the latest.
      } else {
        groups.set(key, { scores: [row.score], latest: row.completedAt });
      }
    }

    return {
      groupBy: args.groupBy,
      attemptsConsidered: filtered.length,
      passThreshold: PASS_THRESHOLD,
      groups: [...groups.entries()]
        .map(([name, group]) => ({
          name,
          attempts: group.scores.length,
          meanScore: Math.round(mean(group.scores) * 10) / 10,
          bestScore: maxOf(group.scores),
          worstScore: minOf(group.scores),
          passingAttempts: group.scores.filter((s) => s >= PASS_THRESHOLD).length,
          lastAttemptAt: group.latest.toISOString(),
        }))
        .sort((a, b) => a.meanScore - b.meanScore),
    };
  },
};

export const studentQuizResultsSkill: AssistantSkill = {
  id: "student-quiz-results",
  name: "Quiz result lookup",
  description:
    "Lets a student search their own past quiz results by quiz name, topic, class, score, or date, " +
    "open a single attempt question by question, and see aggregate trends.",
  audience: "student",
  instructions: [
    "You can look up the student's own past quiz results with the search_quiz_results, " +
      "get_quiz_result_detail, and summarize_performance tools.",
    "Prefer summarize_performance for 'how am I doing' questions and search_quiz_results when the " +
      "student names a quiz, topic, class, or time period. Call search_quiz_results with no filters " +
      "when they ask about everything.",
    "These tools only ever return this student's own data. If the student asks about another " +
      "student, a class average, or anyone else's scores, tell them you can only see their own " +
      "results and suggest they ask their teacher.",
    "get_quiz_result_detail reports attemptState. When it is \"retake_possible\" the response " +
      "carries answerKeyWithheld: you have NOT been given the correct answers or the per-question " +
      "correct/incorrect marks, so you must not state, guess, or narrow down which answer is " +
      "right. Say the quiz is still open to them, then work through the underlying idea. When it " +
      "is \"final\" the attempt is closed and you may go over the correct answers as review.",
    "When you reference a result, name the quiz and the score so the student can find it in their " +
      "Exam History. Never invent a score, a quiz name, or a date that a tool did not return.",
  ].join("\n"),
  tools: [searchQuizResults, getQuizResultDetail, summarizePerformance],
};
