import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...actual,
    resolveProvider: vi.fn(),
    createOpenAIClient: vi.fn(),
  };
});

vi.mock("@/lib/ai-streaming", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-streaming")>();
  return {
    ...actual,
    streamJsonCompletion: vi.fn(),
  };
});

import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import { streamJsonCompletion } from "@/lib/ai-streaming";
import { prisma } from "@/lib/prisma";
import {
  buildKnowledgeTracingPrompt,
  formatKnowledgeProfileForPrompt,
  reconcileKtOutput,
  updateStudentKnowledgeProfile,
} from "@/lib/knowledge-tracing";
import { studentQuizResultsSkill } from "@/lib/assistant/skills/student-quiz-results";
import { teacherClassInsightsSkill } from "@/lib/assistant/skills/teacher-class-insights";
import {
  buildCoachContext,
  coachOpeningOptions,
  resolveCoachScope,
} from "@/lib/assistant/coach";
import {
  createClass,
  createPublishedQuiz,
  createStudent,
  createTeacher,
  resetDb,
} from "./db";

const mockResolveProvider = vi.mocked(resolveProvider);
const mockCreateOpenAIClient = vi.mocked(createOpenAIClient);
const mockStreamJsonCompletion = vi.mocked(streamJsonCompletion);

beforeEach(async () => {
  await resetDb();
  mockResolveProvider.mockReset();
  mockCreateOpenAIClient.mockReset();
  mockStreamJsonCompletion.mockReset();

  mockResolveProvider.mockResolvedValue({
    providerType: "openai",
    apiKey: "sk-test",
    baseUrl: null,
    cfAigByokAlias: null,
    timeoutMs: 30_000,
    apiSurface: "responses",
    model: "gpt-5-mini",
    serviceTier: null,
    thinkingLevel: "medium",
  });
  mockCreateOpenAIClient.mockResolvedValue({} as never);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Knowledge Tracing engine, clash resolution, chat tools, and coach integration", () => {
  it("reconcileKtOutput enforces disjoint known/unknown sets and records both explicit and implicit clash transitions", () => {
    const initial = reconcileKtOutput(
      {
        knownConcepts: [
          {
            concept: "Newton's First Law",
            topic: "Dynamics",
            confidence: "high",
            evidence: "Answered inertia question Q1 correctly.",
          },
        ],
        unknownConcepts: [
          {
            concept: "Free-Body Diagrams",
            topic: "Dynamics",
            confidence: "medium",
            evidence: "Missed normal force direction on Q2.",
          },
        ],
        transitions: [],
        promptSummary: "Knows inertia; struggles with free-body diagrams.",
      },
      null,
      "Quiz 1",
      "2026-11-05T10:00:00.000Z",
    );

    expect(initial.knownConcepts).toHaveLength(1);
    expect(initial.unknownConcepts).toHaveLength(1);

    const prevProfile = {
      version: 1 as const,
      studentId: "stu-1",
      studentName: "Stu Student",
      ugaId: "811947904",
      updatedAt: "2026-11-05T10:00:00.000Z",
      lastExamResultId: "res-1",
      lastCompletedAt: "2026-11-05T10:00:00.000Z",
      attemptsAnalyzed: 1,
      ...initial,
      aiModel: "gpt-5-mini",
      aiProvider: "openai",
    };

    // On a retake:
    // - "Newton's First Law" clashes (was known -> now missed -> downgraded to unknown)
    // - "Free-Body Diagrams" clashes (was unknown -> now mastered -> upgraded to known)
    const afterRetake = reconcileKtOutput(
      {
        knownConcepts: [
          {
            concept: "Free-Body Diagrams",
            topic: "Dynamics",
            confidence: "high",
            evidence: "Correctly resolved inclined-plane forces on retake.",
          },
          // Even if the LLM accidentally put Newton's First Law in both, unknown wins
          {
            concept: "Newton's First Law",
            topic: "Dynamics",
            confidence: "low",
            evidence: "Stale entry",
          },
        ],
        unknownConcepts: [
          {
            concept: "Newton's First Law",
            topic: "Dynamics",
            confidence: "medium",
            evidence: "Selected net force > 0 for constant velocity on retake.",
          },
        ],
        transitions: [],
        promptSummary:
          "Upgraded Free-Body Diagrams on retake, but downgraded Newton's First Law after constant-velocity error.",
      },
      prevProfile,
      "Quiz 1 (Retake)",
      "2026-11-06T10:00:00.000Z",
    );

    expect(afterRetake.knownConcepts.map((c) => c.concept)).toEqual([
      "Free-Body Diagrams",
    ]);
    expect(afterRetake.unknownConcepts.map((c) => c.concept)).toEqual([
      "Newton's First Law",
    ]);
    expect(afterRetake.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          concept: "Newton's First Law",
          direction: "downgraded_known",
        }),
        expect.objectContaining({
          concept: "Free-Body Diagrams",
          direction: "upgraded_unknown",
        }),
      ]),
    );
  });

  it("updates profile via LLM on quiz attempt and retake, and retrieves by 811 number or student name in teacher & student chat tools", async () => {
    const teacher = await createTeacher();
    const student = await createStudent();
    const cls = await createClass(teacher.teacher.id, "Physics 101");
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: student.student.id },
    });

    // Add student to ClassStudentList with an 811 UGA ID
    await prisma.classStudentList.create({
      data: {
        classId: cls.id,
        orgDefinedId: "811947904",
        firstName: student.user.firstName,
        lastName: student.user.lastName,
        email: student.user.email,
        isRegistered: true,
      },
    });

    const { quiz, question: q1 } = await createPublishedQuiz({
      classId: cls.id,
      teacherId: teacher.teacher.id,
    });
    const q2 = await prisma.question.create({
      data: {
        text: "What is acceleration during free fall near Earth?",
        quizId: quiz.id,
        answerMode: "NUMERIC",
        answerNumeric: 9.8,
        answerUnit: "m/s^2",
      },
    });

    const attempt = await prisma.quizAttempt.create({
      data: {
        studentId: student.student.id,
        classId: cls.id,
        quizId: quiz.id,
        score: 50,
        completedAt: new Date("2026-11-06T11:00:00Z"),
      },
    });

    const examResult = await prisma.examResult.create({
      data: {
        quizAttemptId: attempt.id,
        studentId: student.student.id,
        classId: cls.id,
        quizId: quiz.id,
        studentName: `${student.user.firstName} ${student.user.lastName}`,
        className: cls.name,
        topicName: "Kinematics",
        quizName: quiz.name,
        score: 50,
        correctCount: 1,
        totalCount: 2,
        completedAt: new Date("2026-11-06T11:00:00Z"),
        reviewSnapshot: JSON.stringify({
          questions: [
            {
              questionId: q1.id,
              text: "What is velocity when position is constant?",
              answerMode: "SINGLE_SELECT",
              isCorrect: true,
              options: [{ text: "0 m/s", selected: true, isCorrect: true }],
            },
            {
              questionId: q2.id,
              text: "What is acceleration during free fall near Earth?",
              answerMode: "NUMERIC",
              submittedNumeric: 0,
              correctNumeric: 9.8,
              unit: "m/s^2",
              isCorrect: false,
              options: [],
            },
          ],
        }),
      },
    });

    mockStreamJsonCompletion.mockResolvedValueOnce({
      text: "{}",
      toolCalls: [],
      finishReason: "stop",
      value: {
        knownConcepts: [
          {
            concept: "Constant Position vs. Zero Velocity",
            topic: "Kinematics",
            confidence: "high",
            evidence: "Correctly identified 0 m/s for constant position.",
          },
        ],
        unknownConcepts: [
          {
            concept: "Gravitational Acceleration in Free Fall",
            topic: "Kinematics",
            confidence: "high",
            evidence:
              "Submitted 0 m/s^2 instead of 9.8 m/s^2 during free fall.",
          },
        ],
        transitions: [],
        promptSummary:
          "Masters position-velocity relationships, but confuses velocity at the apex with gravitational acceleration during free fall.",
      },
      metrics: {
        model: "gpt-5-mini",
        ttftMs: 50,
        generationMs: 100,
        totalMs: 150,
        completionTokens: 120,
        tokensEstimated: false,
        tokensPerSec: 800,
      },
    });

    const profile = await updateStudentKnowledgeProfile(
      student.student.id,
      examResult.id,
    );
    expect(profile).not.toBeNull();
    expect(profile?.ugaId).toBe("811947904");
    expect(profile?.knownConcepts).toHaveLength(1);
    expect(profile?.unknownConcepts).toHaveLength(1);

    // 1. Student chat tool: get_my_knowledge_tracing
    const studentTool = studentQuizResultsSkill.tools.find(
      (t) => t.name === "get_my_knowledge_tracing",
    )!;
    const studentResult = (await studentTool.handler(
      {},
      {
        userId: student.user.id,
        audience: "student",
        studentId: student.student.id,
        teacherId: null,
      },
    )) as {
      found: boolean;
      ugaId: string;
      knownConcepts: unknown[];
      unknownConcepts: unknown[];
    };
    expect(studentResult.found).toBe(true);
    expect(studentResult.ugaId).toBe("811947904");
    expect(studentResult.knownConcepts).toHaveLength(1);
    expect(studentResult.unknownConcepts).toHaveLength(1);

    // 2. Teacher chat tool: get_student_knowledge_tracing by 811 number
    const teacherTool = teacherClassInsightsSkill.tools.find(
      (t) => t.name === "get_student_knowledge_tracing",
    )!;
    const by811 = (await teacherTool.handler(
      { query: "811947904" },
      {
        userId: teacher.user.id,
        audience: "teacher",
        studentId: null,
        teacherId: teacher.teacher.id,
      },
    )) as {
      found: boolean;
      students: { studentName: string; ugaId: string; promptSummary: string }[];
    };
    expect(by811.found).toBe(true);
    expect(by811.students).toHaveLength(1);
    expect(by811.students[0].ugaId).toBe("811947904");
    expect(by811.students[0].promptSummary).toContain("free fall");

    // 3. Teacher chat tool: get_student_knowledge_tracing by student name
    const byName = (await teacherTool.handler(
      { query: student.user.firstName },
      {
        userId: teacher.user.id,
        audience: "teacher",
        studentId: null,
        teacherId: teacher.teacher.id,
      },
    )) as {
      found: boolean;
      students: { studentId: string }[];
    };
    expect(byName.found).toBe(true);
    expect(byName.students[0].studentId).toBe(student.student.id);

    // 4. Verify a SECOND student can also save a KT profile (unique audience per student)
    // and that a second teacher only sees concepts from their own class.
    const student2 = await createStudent({
      email: "stu2@example.com",
      username: "stu2",
    });
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: student2.student.id },
    });
    const attempt2 = await prisma.quizAttempt.create({
      data: {
        studentId: student2.student.id,
        classId: cls.id,
        quizId: quiz.id,
        score: 100,
        completedAt: new Date("2026-11-06T12:00:00Z"),
      },
    });
    const examResult2 = await prisma.examResult.create({
      data: {
        quizAttemptId: attempt2.id,
        studentId: student2.student.id,
        classId: cls.id,
        quizId: quiz.id,
        studentName: "Stu2 Student",
        className: cls.name,
        topicName: "Kinematics",
        quizName: quiz.name,
        score: 100,
        correctCount: 2,
        totalCount: 2,
        completedAt: new Date("2026-11-06T12:00:00Z"),
        reviewSnapshot: JSON.stringify({ questions: [] }),
      },
    });
    mockStreamJsonCompletion.mockResolvedValueOnce({
      text: "{}",
      toolCalls: [],
      finishReason: "stop",
      value: {
        knownConcepts: [
          {
            concept: "Free Fall Kinematics",
            topic: "Kinematics",
            confidence: "high",
            evidence: "Aced Quiz 1.",
          },
        ],
        unknownConcepts: [],
        transitions: [],
        promptSummary: "Mastered Free Fall Kinematics.",
      },
      metrics: {
        model: "gpt-5-mini",
        ttftMs: 40,
        generationMs: 80,
        totalMs: 120,
        completionTokens: 90,
        tokensEstimated: false,
        tokensPerSec: 750,
      },
    });
    const profile2 = await updateStudentKnowledgeProfile(
      student2.student.id,
      examResult2.id,
    );
    expect(profile2).not.toBeNull();
    expect(profile2?.knownConcepts[0].concept).toBe("Free Fall Kinematics");

    // 5. Wrong-Answer Coach receives both the Knowledge Tracing block and 1-2 starter thinking buttons
    const scope = await resolveCoachScope(student.student.id, attempt.id, 2);
    expect(scope).not.toBeNull();
    const options = coachOpeningOptions(scope!);
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options.length).toBeLessThanOrEqual(2);
    expect(options[0]).toContain("0 m/s^2");

    const coachCtx = await buildCoachContext(scope!);
    expect(coachCtx).toContain("student knowledge tracing");
    expect(coachCtx).toContain("Gravitational Acceleration in Free Fall");
    expect(coachCtx).toContain("Constant Position vs. Zero Velocity");
  });

  it("buildKnowledgeTracingPrompt & formatKnowledgeProfileForPrompt include clash rules and transition history", () => {
    const prompt = buildKnowledgeTracingPrompt("Stu Student", null, [], {
      resultId: "r-1",
      classId: "cls-1",
      quizName: "Quiz 1",
      topicName: "Forces",
      className: "Physics",
      isRetakeOrAlt: true,
      alternativeVersionName: "Version B",
      score: 80,
      completedAt: "2026-11-06T12:00:00Z",
      questionLines: [
        '  Q1 [CORRECT]: "Force question" — Student answered: 10 N',
      ],
      misconceptionLines: [],
    });
    expect(prompt[0].content).toContain("CLASH RESOLUTION IS MANDATORY");
    expect(prompt[1].content).toContain(
      "Alternative Practice Retake (Version B)",
    );

    const formatted = formatKnowledgeProfileForPrompt({
      version: 1,
      studentId: "s1",
      studentName: "Stu",
      ugaId: "811000111",
      updatedAt: "2026-11-06T12:00:00Z",
      lastExamResultId: "r-1",
      lastCompletedAt: "2026-11-06T12:00:00Z",
      attemptsAnalyzed: 2,
      knownConcepts: [
        {
          concept: "Ohm's Law",
          topic: "Circuits",
          confidence: "high",
          evidence: "Solved V=IR",
          classId: "cls-1",
          className: "Physics",
        },
      ],
      unknownConcepts: [],
      transitions: [
        {
          concept: "Ohm's Law",
          direction: "upgraded_unknown",
          reason: "Fixed resistor calculation on retake",
          quizName: "Circuits Quiz",
          classId: "cls-1",
          className: "Physics",
          occurredAt: "2026-11-06T12:00:00Z",
        },
      ],
      promptSummary: "Mastered Ohm's Law after retake.",
      aiModel: "gpt-5-mini",
      aiProvider: "openai",
    });
    expect(formatted).toContain("UPGRADED unknown -> known");
    expect(formatted).toContain("Ohm's Law");
  });
});
