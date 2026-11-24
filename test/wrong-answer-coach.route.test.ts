import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const decisionsCreate = vi.fn();
const streamJsonMock = vi.fn();

vi.mock("@/lib/ai-decisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-decisions")>();
  return {
    ...actual,
    createDecisions: (...args: unknown[]) => decisionsCreate(...args),
  };
});

vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...actual,
    resolveProvider: vi.fn(async (useCase: string) => ({
      providerType: "openai",
      apiKey: "sk-test",
      baseUrl: null,
      model:
        useCase === "wrong_answer_coach_classify" ? "gpt-6-luna" : "gpt-5.1",
      serviceTier: null,
      thinkingLevel: null,
      cfAigByokAlias: null,
      timeoutMs: 30_000,
    })),
    createOpenAIClient: vi.fn(async () => ({})),
  };
});

vi.mock("@/lib/ai-streaming", () => ({
  streamJsonCompletion: (...args: unknown[]) => streamJsonMock(...args),
  streamOptionsFor: () => ({}),
  transportFor: () => "chat_completions",
}));

vi.mock("@/lib/guardrails", () => ({
  moderateText: vi.fn(async () => ({ flagged: false, categories: [] })),
  checkContentSafety: vi.fn(async () => ({
    blocked: false,
    reason: null,
    category: null,
  })),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass } from "./db";
import { computeQuestionSourceHash } from "@/lib/wrong-answer-coach-rules";
import {
  getCoachAnswerKeyWithheldQuestionIds,
  getCoachWithheldQuestionsForStudentQuiz,
} from "@/lib/wrong-answer-coach-engine";
import { DecisionsApiError } from "@/lib/ai-decisions";
import {
  GET as getPractice,
  POST as postPractice,
} from "@/app/api/quiz/practice/route";
import { PATCH as patchVariants } from "@/app/api/quizzes/[id]/variants/route";
import { GET as getEligibility } from "@/app/api/student/attempts/[attemptId]/coach-eligibility/route";
import { POST as startSession } from "@/app/api/student/attempts/[attemptId]/coach/sessions/route";
import { POST as respondTurn } from "@/app/api/student/coach/sessions/[sessionId]/respond/route";

const mockAuth = vi.mocked(auth);

async function seedCoachScenario(opts?: {
  retakeable?: boolean;
  consent?: "AGREE" | "DECLINE" | "NONE";
  check1Label?: string | null;
}) {
  const { teacher } = await createTeacher();
  const { user: studentUser, student } = await createStudent();
  const cls = await createClass(teacher.id, "Physics 101");

  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });

  await prisma.misconception.upsert({
    where: { misconceptionId: "M1" },
    update: {},
    create: {
      misconceptionId: "M1",
      statement: "Zero velocity implies zero acceleration.",
      deprecated: false,
    },
  });
  await prisma.misconception.upsert({
    where: { misconceptionId: "M2" },
    update: {},
    create: {
      misconceptionId: "M2",
      statement: "Acceleration points upward on the way up.",
      deprecated: false,
    },
  });

  if (opts?.consent !== "NONE") {
    const form = await prisma.consentFormVersion.create({
      data: {
        role: "STUDENT",
        version: "v1.0",
        title: "Study Consent",
        bodyHtml: "<p>Consent text</p>",
        isActive: true,
      },
    });
    await prisma.consentRecord.create({
      data: {
        userId: studentUser.id,
        role: "STUDENT",
        formVersionId: form.id,
        decision: opts?.consent ?? "AGREE",
        signatureTypedName: "Stu Student",
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        deviceType: "desktop",
        signerNameSnapshot: "Stu Student",
        signerEmailSnapshot: studentUser.email,
      },
    });
  }

  const topic = await prisma.topic.create({
    data: { name: "Kinematics", teacherId: teacher.id },
  });
  const quiz = await prisma.quiz.create({
    data: { name: "Kinematics Quiz", topicId: topic.id, teacherId: teacher.id },
  });
  await prisma.classQuiz.create({
    data: {
      classId: cls.id,
      quizId: quiz.id,
      published: true,
      maxAttempts: opts?.retakeable ? 3 : 1,
    },
  });

  const question = await prisma.question.create({
    data: {
      quizId: quiz.id,
      text: "A ball is thrown straight up. What is its acceleration at the peak?",
      answerMode: "SINGLE_SELECT",
      options: {
        create: [
          { text: "9.8 m/s^2 downward", isCorrect: true },
          { text: "0 m/s^2", isCorrect: false },
          { text: "9.8 m/s^2 upward", isCorrect: false },
        ],
      },
    },
    include: { options: { orderBy: { id: "asc" } } },
  });

  const correctOpt = question.options.find((o) => o.isCorrect)!;
  const wrongOpt1 = question.options.find((o) => o.text === "0 m/s^2")!;
  const wrongOpt2 = question.options.find(
    (o) => o.text === "9.8 m/s^2 upward",
  )!;

  const sourceHash = computeQuestionSourceHash({
    text: question.text,
    answerMode: "SINGLE_SELECT",
    options: question.options,
  });

  await prisma.questionCoachMetadata.create({
    data: {
      questionId: question.id,
      sourceHash,
      status: "READY",
      keyPointsJson: JSON.stringify([
        "Gravity exerts a constant downward acceleration of 9.8 m/s^2 throughout flight.",
      ]),
      optionLabelsJson: JSON.stringify([
        {
          optionId: correctOpt.id,
          optionText: correctOpt.text,
          isCorrect: true,
          misconceptionCode: null,
        },
        {
          optionId: wrongOpt1.id,
          optionText: wrongOpt1.text,
          isCorrect: false,
          misconceptionCode:
            opts?.check1Label === undefined ? "M1" : opts.check1Label,
        },
        {
          optionId: wrongOpt2.id,
          optionText: wrongOpt2.text,
          isCorrect: false,
          misconceptionCode: "M2",
        },
      ]),
      labeledAt: new Date(),
    },
  });

  const sourceSnapshot = JSON.stringify([
    {
      id: question.id,
      sourceQuestionId: question.id,
      text: question.text,
      answerMode: "SINGLE_SELECT",
      options: question.options.map((o) => ({
        id: o.id,
        text: o.text,
        isCorrect: o.isCorrect,
      })),
    },
  ]);

  await prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Check 3 Set",
      variation: "NUMBERS",
      status: "PUBLISHED",
      coachRole: "COACH_CHECK3",
      coachLabeledAt: new Date(),
      sourceSnapshot,
      objectives: "[]",
      questions: JSON.stringify([
        {
          id: "v-c3-q1",
          sourceQuestionId: question.id,
          text: "A coin is tossed vertically upward. What is its acceleration at the highest point?",
          answerMode: "SINGLE_SELECT",
          options: [
            {
              id: "c3-o1",
              text: "9.8 m/s^2 downward",
              isCorrect: true,
              misconceptionCode: null,
            },
            {
              id: "c3-o2",
              text: "0 m/s^2",
              isCorrect: false,
              misconceptionCode: "M1",
            },
            {
              id: "c3-o3",
              text: "9.8 m/s^2 upward",
              isCorrect: false,
              misconceptionCode: "M2",
            },
          ],
        },
      ]),
    },
  });

  await prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Held-Out Set",
      variation: "CONTEXT",
      status: "PUBLISHED",
      coachRole: "COACH_HELDOUT",
      coachLabeledAt: new Date(),
      sourceSnapshot,
      objectives: "[]",
      questions: JSON.stringify([
        {
          id: "v-ho-q1",
          sourceQuestionId: question.id,
          text: "A rocket's engine shuts off while rising. At its apex, what is its acceleration?",
          answerMode: "SINGLE_SELECT",
          options: [
            {
              id: "ho-o1",
              text: "9.8 m/s^2 downward",
              isCorrect: true,
              misconceptionCode: null,
            },
            {
              id: "ho-o2",
              text: "0 m/s^2",
              isCorrect: false,
              misconceptionCode: "M1",
            },
            {
              id: "ho-o3",
              text: "9.8 m/s^2 upward",
              isCorrect: false,
              misconceptionCode: "M2",
            },
          ],
        },
      ]),
    },
  });

  const now = new Date();
  const attempt = await prisma.quizAttempt.create({
    data: {
      studentId: student.id,
      quizId: quiz.id,
      classId: cls.id,
      score: 0,
      completedAt: now,
    },
  });

  await prisma.examResult.create({
    data: {
      quizAttemptId: attempt.id,
      studentId: student.id,
      quizId: quiz.id,
      classId: cls.id,
      className: cls.name,
      topicName: topic.name,
      quizName: quiz.name,
      score: 0,
      correctCount: 0,
      totalCount: 1,
      completedAt: now,
      reviewSnapshot: JSON.stringify({
        questions: [
          {
            questionId: question.id,
            text: question.text,
            isCorrect: false,
            options: question.options.map((o) => ({
              optionId: o.id,
              text: o.text,
              isCorrect: o.isCorrect,
              selected: o.id === wrongOpt1.id,
            })),
          },
        ],
      }),
    },
  });

  mockAuth.mockResolvedValue({
    user: { id: studentUser.id, role: "STUDENT" },
  } as never);

  return { teacher, studentUser, student, cls, quiz, question, attempt };
}

function mockDecisionsChoice(choice: string, confidence = 0.94) {
  decisionsCreate.mockResolvedValue({
    model: "gpt-6-luna",
    answers: [
      {
        name: "check2_classification",
        type: "choice",
        choice,
        confidence,
        probabilities: [
          { value: choice, probability: confidence },
          { value: "neither", probability: 1 - confidence },
        ],
      },
    ],
    latencyMs: 20,
    raw: {},
  });
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  const body =
    "Gravity continues to pull downward at 9.8 m/s^2 even at the top of the trajectory, so double-check the choice carefully.";
  streamJsonMock.mockResolvedValue({
    value: { explanation_body: body },
    text: JSON.stringify({ explanation_body: body }),
    metrics: { totalMs: 40, completionTokens: 24 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Wrong Answer Coach end-to-end student workflow", () => {
  it("withholds eligibility when retakes are still open", async () => {
    const { attempt } = await seedCoachScenario({ retakeable: true });
    const res = await getEligibility(
      new Request(
        `http://localhost/api/student/attempts/${attempt.id}/coach-eligibility`,
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].eligible).toBe(false);
  });

  it("runs Slip path (Row 2) end-to-end with strict pre-Step-10 answer-key firewall", async () => {
    const { attempt, question, student, studentUser } =
      await seedCoachScenario();
    mockDecisionsChoice("sound", 0.96);

    // Cross-surface firewall should withhold answer key before Coach finishes
    const withheldBefore = await getCoachAnswerKeyWithheldQuestionIds({
      attemptId: attempt.id,
      studentId: student.id,
      studentUserId: studentUser.id,
    });
    expect(withheldBefore.has(question.id)).toBe(true);

    // Start session
    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    expect(startRes.status).toBe(200);
    const started = await startRes.json();
    expect(started.state).toBe("AWAITING_EXPLANATION");
    // ZERO LEAKAGE: correctOptionText must NOT be present before Step 10
    expect(started.originalQuestion.correctOptionText).toBeUndefined();

    // Submit explanation -> Check 2 (5 Decisions API runs) -> Check 3 MCQ
    const expRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${started.sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "Gravity pulls downward at 9.8 m/s^2 the whole time, I misclicked 0.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId: started.sessionId }) },
    );
    expect(expRes.status).toBe(200);
    expect(decisionsCreate).toHaveBeenCalledTimes(5);
    const afterExp = await expRes.json();
    expect(afterExp.state).toBe("AWAITING_SECOND_QUESTION");
    expect(afterExp.originalQuestion.correctOptionText).toBeUndefined();
    expect(afterExp.activeMcq.step).toBe("second_question");

    // Pick correct option on Check 3 -> Held-Out MCQ
    const c3Correct = afterExp.activeMcq.options.find(
      (o: { text: string }) => o.text === "9.8 m/s^2 downward",
    );
    const c3Res = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${started.sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "second_question",
            optionToken: c3Correct.optionToken,
          }),
        },
      ),
      { params: Promise.resolve({ sessionId: started.sessionId }) },
    );
    expect(c3Res.status).toBe(200);
    const afterC3 = await c3Res.json();
    expect(afterC3.state).toBe("AWAITING_HELDOUT_QUESTION");
    expect(afterC3.originalQuestion.correctOptionText).toBeUndefined();

    // Answer Held-Out -> Step 10 Tutoring -> COMPLETED
    const hoChoice = afterC3.activeMcq.options[0];
    const hoRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${started.sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "held_out_question",
            optionToken: hoChoice.optionToken,
          }),
        },
      ),
      { params: Promise.resolve({ sessionId: started.sessionId }) },
    );
    expect(hoRes.status).toBe(200);
    const completed = await hoRes.json();
    expect(completed.state).toBe("COMPLETED");
    expect(completed.originalQuestion.correctOptionText).toBe(
      "9.8 m/s^2 downward",
    );

    // Verify persisted diagnosis row = Row 2 (SLIP)
    const dbRow = await prisma.wrongAnswerCoachSession.findUnique({
      where: { id: started.sessionId },
    });
    expect(dbRow?.diagnosis).toBe("SLIP");
    expect(dbRow?.decisionTableRow).toBe(2);
    expect(dbRow?.tutoringUsedFallback).toBe(false);

    // Cross-surface firewall releases after COMPLETED
    const withheldAfter = await getCoachAnswerKeyWithheldQuestionIds({
      attemptId: attempt.id,
      studentId: student.id,
      studentUserId: studentUser.id,
    });
    expect(withheldAfter.has(question.id)).toBe(false);
  });

  it("recovers cleanly from partial Check 2 Decisions API failure via CLASSIFYING_FAILED retry", async () => {
    const { attempt, question } = await seedCoachScenario();

    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    const { sessionId } = await startRes.json();

    // First 2 runs succeed, run 3 fails with 503
    let calls = 0;
    decisionsCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 3) {
        throw new Error("503 Service Unavailable");
      }
      return {
        model: "gpt-6-luna",
        answers: [
          {
            name: "check2_classification",
            type: "choice",
            choice: "M1",
            confidence: 0.9,
            probabilities: [{ value: "M1", probability: 0.9 }],
          },
        ],
        latencyMs: 10,
        raw: {},
      };
    });

    const failRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "It stops moving at the top so acceleration is zero.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(failRes.status).toBe(503);

    // Now retry_classification completes only the remaining slots and advances to Check 3
    const retryRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "retry_classification" }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(retryRes.status).toBe(200);
    const body = await retryRes.json();
    // All 3 checks run before diagnosis per PDF Step 7
    expect(body.state).toBe("AWAITING_SECOND_QUESTION");
    expect(body.activeMcq.step).toBe("second_question");
  });

  it("triggers immediate crisis redirect with PERSONAL_SUPPORT_NEEDED even when message also asks for the answer", async () => {
    const { attempt, question } = await seedCoachScenario();
    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    const { sessionId } = await startRes.json();

    const crisisRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "Just tell me the answer, I want to kill myself.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(crisisRes.status).toBe(200);
    const session = await crisisRes.json();
    // Per plan §3.1/§3.5: crisis redirect leaves state unchanged, logs SUPPORT_REDIRECT,
    // flags PERSONAL_SUPPORT_NEEDED, and never consumes the explanation turn or leaks the answer.
    expect(session.state).toBe("AWAITING_EXPLANATION");
    expect(session.originalQuestion.correctOptionText).toBeUndefined();
    expect(
      session.messages.some(
        (m: { kind: string }) => m.kind === "SUPPORT_REDIRECT",
      ),
    ).toBe(true);

    const dbRow = await prisma.wrongAnswerCoachSession.findUnique({
      where: { id: sessionId },
    });
    expect(dbRow?.diagnosis).toBeNull();
    expect(dbRow?.reviewStatus).toBe("PENDING");
    expect(JSON.parse(dbRow!.flagsJson)).toContain("PERSONAL_SUPPORT_NEEDED");
  });

  it("falls back to deterministic tutoring after two invalid Task B outputs", async () => {
    const { attempt, question } = await seedCoachScenario();
    mockDecisionsChoice("M1", 0.95);
    // Return invalid output mentioning Option B and Table 3
    const badBody = "Based on Table 3, Option B is the correct choice.";
    streamJsonMock.mockResolvedValue({
      value: { explanation_body: badBody },
      text: JSON.stringify({ explanation_body: badBody }),
      metrics: { totalMs: 20, completionTokens: 12 },
    });

    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    const { sessionId } = await startRes.json();

    const expRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "Zero velocity means zero acceleration.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    const c3Token = (await expRes.json()).activeMcq.options[0].optionToken;

    const c3Res = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "second_question",
            optionToken: c3Token,
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    const hoToken = (await c3Res.json()).activeMcq.options[0].optionToken;

    const hoRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "held_out_question",
            optionToken: hoToken,
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(hoRes.status).toBe(200);
    const completed = await hoRes.json();
    expect(completed.state).toBe("COMPLETED");
    expect(completed.originalQuestion.correctOptionText).toBe(
      "9.8 m/s^2 downward",
    );

    const dbRow = await prisma.wrongAnswerCoachSession.findUnique({
      where: { id: sessionId },
    });
    expect(dbRow?.tutoringUsedFallback).toBe(true);
    expect(JSON.parse(dbRow!.flagsJson)).toContain("TUTORING_FALLBACK");
  });

  it("blocks active coach continuation if teacher reopens retakes mid-session", async () => {
    const { attempt, question, cls, quiz } = await seedCoachScenario();
    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    expect(startRes.status).toBe(200);
    const { sessionId } = await startRes.json();

    // Teacher raises maxAttempts from 1 to 3 while session is active
    await prisma.classQuiz.update({
      where: { classId_quizId: { classId: cls.id, quizId: quiz.id } },
      data: { maxAttempts: 3 },
    });

    const respondRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "Gravity acts downward.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(respondRes.status).toBe(409);
  });

  it("isolates COACH_CHECK3/COACH_HELDOUT from student practice and rejects assigning practiced versions", async () => {
    const { cls, quiz, student, teacher } = await seedCoachScenario();
    const teacherUser = await prisma.teacher.findUnique({
      where: { id: teacher.id },
      select: { userId: true },
    });

    // Student practice GET must NOT serve COACH_CHECK3 or COACH_HELDOUT versions
    const pracGet = await getPractice(
      new NextRequest(
        `http://localhost/api/quiz/practice?quizId=${quiz.id}&classId=${cls.id}`,
      ),
    );
    expect(pracGet.status).toBe(200);
    const pracBody = await pracGet.json();
    expect(pracBody.available).toBe(0);

    // Student practice POST must also refuse when only Coach versions exist
    const pracPost = await postPractice(
      new NextRequest("http://localhost/api/quiz/practice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quizId: quiz.id, classId: cls.id }),
      }),
    );
    expect(pracPost.status).toBe(404);

    // A published PRACTICE version that already has a QuizPracticeAttempt cannot be assigned to Coach
    const practicedVersion = await prisma.quizPracticeVersion.create({
      data: {
        quizId: quiz.id,
        name: "Already Practiced",
        variation: "NUMBERS",
        status: "PUBLISHED",
        coachRole: "PRACTICE",
        sourceSnapshot: "[]",
        objectives: "[]",
        questions: "[]",
      },
    });
    await prisma.quizPracticeAttempt.create({
      data: {
        versionId: practicedVersion.id,
        versionName: practicedVersion.name,
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        score: 100,
        answers: "[]",
        questions: "[]",
        completedAt: new Date(),
      },
    });

    mockAuth.mockResolvedValue({
      user: { id: teacherUser!.userId, role: "TEACHER" },
    } as never);
    const assignRes = await patchVariants(
      new NextRequest(`http://localhost/api/quizzes/${quiz.id}/variants`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId: practicedVersion.id,
          action: "set_coach_role",
          coachRole: "COACH_CHECK3",
        }),
      }),
      { params: Promise.resolve({ id: quiz.id }) },
    );
    expect(assignRes.status).toBe(409);
  });

  it("withholds answer key across attempts until Coach completes or ends INCOMPLETE", async () => {
    const {
      attempt: attempt2,
      question,
      cls,
      quiz,
      student,
      studentUser,
    } = await seedCoachScenario();

    // Create an earlier attempt 1 where student answered the SAME question CORRECTLY
    const earlier = new Date(Date.now() - 60_000);
    const attempt1 = await prisma.quizAttempt.create({
      data: {
        studentId: student.id,
        quizId: quiz.id,
        classId: cls.id,
        score: 100,
        completedAt: earlier,
      },
    });
    await prisma.examResult.create({
      data: {
        quizAttemptId: attempt1.id,
        studentId: student.id,
        quizId: quiz.id,
        classId: cls.id,
        className: cls.name,
        topicName: "Kinematics",
        quizName: quiz.name,
        score: 100,
        correctCount: 1,
        totalCount: 1,
        completedAt: earlier,
        reviewSnapshot: JSON.stringify({
          questions: [
            {
              questionId: question.id,
              text: question.text,
              isCorrect: true,
              options: [
                { text: "9.8 m/s^2 downward", isCorrect: true, selected: true },
              ],
            },
          ],
        }),
      },
    });

    // Reading attempt 1 MUST still withhold Q because attempt 2 has an unfinished Coach check!
    const withheldOnAttempt1 = await getCoachWithheldQuestionsForStudentQuiz({
      attemptId: attempt1.id,
      studentId: student.id,
      studentUserId: studentUser.id,
      classId: cls.id,
      quizId: quiz.id,
    });
    expect(withheldOnAttempt1.questionIds.has(question.id)).toBe(true);

    // Start & explicitly leave attempt 2's session (INCOMPLETE) -> firewall releases!
    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt2.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt2.id }) },
    );
    const { sessionId } = await startRes.json();
    await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "leave" }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );

    const withheldAfterLeave = await getCoachWithheldQuestionsForStudentQuiz({
      attemptId: attempt1.id,
      studentId: student.id,
      studentUserId: studentUser.id,
      classId: cls.id,
      quizId: quiz.id,
    });
    expect(withheldAfterLeave.questionIds.has(question.id)).toBe(false);
  });

  it("settles malformed Decisions API responses after 1 retry as neither + CHECK2_PARSE_FAILURE instead of looping CLASSIFYING_FAILED", async () => {
    const { attempt, question } = await seedCoachScenario();
    decisionsCreate.mockRejectedValue(
      new DecisionsApiError("Invalid Decisions API response shape", {
        status: 200,
        code: "INVALID_RESPONSE_PAYLOAD",
        transient: false,
      }),
    );

    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    const { sessionId } = await startRes.json();

    const expRes = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "Gravity keeps pulling down.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(expRes.status).toBe(200);
    const view = await expRes.json();
    expect(view.state).toBe("AWAITING_SECOND_QUESTION");

    const dbRow = await prisma.wrongAnswerCoachSession.findUnique({
      where: { id: sessionId },
    });
    expect(dbRow?.check2ResultKind).toBe("neither");
    expect(JSON.parse(dbRow!.flagsJson)).toContain("CHECK2_PARSE_FAILURE");
  });

  it("re-opens reviewStatus to PENDING on a repeat crisis message at Step 7 even after teacher marked REVIEWED", async () => {
    const { attempt, question } = await seedCoachScenario();
    mockDecisionsChoice("sound", 0.95);

    const startRes = await startSession(
      new NextRequest(
        `http://localhost/api/student/attempts/${attempt.id}/coach/sessions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ questionId: question.id }),
        },
      ),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    const { sessionId } = await startRes.json();

    // Advance to Step 7 (AWAITING_SECOND_QUESTION)
    await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "explanation",
            text: "Gravity pulls downward.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );

    // Simulate teacher already having reviewed an earlier crisis flag
    await prisma.wrongAnswerCoachSession.update({
      where: { id: sessionId },
      data: {
        flagsJson: JSON.stringify(["PERSONAL_SUPPORT_NEEDED"]),
        hasFlags: true,
        reviewStatus: "REVIEWED",
      },
    });

    // Repeat crisis message at Step 7 MUST reset reviewStatus back to PENDING!
    const repeatCrisis = await respondTurn(
      new NextRequest(
        `http://localhost/api/student/coach/sessions/${sessionId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "free_text",
            text: "I am having a panic attack and need crisis help.",
          }),
        },
      ),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(repeatCrisis.status).toBe(200);
    const updated = await prisma.wrongAnswerCoachSession.findUnique({
      where: { id: sessionId },
    });
    expect(updated?.reviewStatus).toBe("PENDING");
  });
});
