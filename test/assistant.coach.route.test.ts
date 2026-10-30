import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
// Only the provider lookup and client are stubbed; the guardrails, the agent
// loop, the tools, the stores and the routes all run for real.
vi.mock("@/lib/ai-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-provider")>()),
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(),
}));
// Real guardrails, except that a test can force a verdict.
vi.mock("@/lib/guardrail-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/guardrail-runner")>();
  return { ...actual, guardChatTurn: vi.fn(actual.guardChatTurn) };
});
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  getS3Config: () => ({ bucket: "test", region: "us-east-1" }),
  signObjectReadUrl: vi.fn(
    async (_bucket: string, key: string) => `https://signed.test/${key}`,
  ),
}));

import { GET as GET_COACH } from "@/app/api/assistant/coach/route";
import { POST as POST_COACH_CHAT } from "@/app/api/assistant/coach/chat/route";
import { POST as POST_PRACTICE } from "@/app/api/assistant/coach/practice/route";
import { POST as POST_CHAT } from "@/app/api/assistant/chat/route";
import { GET as GET_CONVERSATIONS } from "@/app/api/assistant/conversations/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import type { ResolvedProvider } from "@/lib/ai-provider";
import { resetSurfaceMemo } from "@/lib/ai-streaming";
import { guardChatTurn } from "@/lib/guardrail-runner";
import { saveAssistantSettings } from "@/lib/assistant/config";
import type { AssistantStreamEvent } from "@/lib/assistant/types";
import type {
  CoachPracticeResult,
  CoachSessionView,
} from "@/lib/assistant/coach-types";
import {
  resetDb,
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
} from "./db";

const mockAuth = vi.mocked(auth);
const mockResolve = vi.mocked(resolveProvider);
const mockClient = vi.mocked(createOpenAIClient);

const asStudent = (userId: string) =>
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "STUDENT" },
  } as never);
const asTeacher = (userId: string) =>
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);

const provider: ResolvedProvider = {
  providerType: "openai",
  baseUrl: null,
  apiKey: "k",
  model: "gpt-test",
  serviceTier: null,
  thinkingLevel: null,
  cfAigByokAlias: null,
  timeoutMs: 1000,
  apiSurface: "chat_completions",
};

type Round = {
  text?: string;
  toolCalls?: Array<{ name: string; args: object }>;
};

/** A scripted model: one streamed round per call, recording every request. */
function scriptModel(rounds: Round[]) {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> =
    [];
  let index = 0;
  mockResolve.mockResolvedValue(provider);
  mockClient.mockResolvedValue({
    chat: {
      completions: {
        create: vi.fn(async (params: never) => {
          calls.push(params);
          const round = rounds[Math.min(index, rounds.length - 1)];
          index += 1;
          const chunks: unknown[] = [];
          for (const char of round.text ?? "")
            chunks.push({ choices: [{ delta: { content: char } }] });
          (round.toolCalls ?? []).forEach((call, i) =>
            chunks.push({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: i,
                        id: `call-${index}-${i}`,
                        function: {
                          name: call.name,
                          arguments: JSON.stringify(call.args),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          );
          chunks.push({
            choices: [
              {
                delta: {},
                finish_reason: round.toolCalls?.length ? "tool_calls" : "stop",
              },
            ],
            usage: { completion_tokens: 5 },
          });
          return {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) yield chunk;
            },
          };
        }),
      },
    },
  } as never);
  return calls;
}

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const getCoach = (attemptId: string, questionNumber: number | string) =>
  new Request(
    `http://localhost/api/assistant/coach?attemptId=${attemptId}&questionNumber=${questionNumber}`,
  );

async function events(res: Response): Promise<AssistantStreamEvent[]> {
  return (await res.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const ATTEMPT = "attempt-coach-1";

/**
 * One enrolled student with a graded attempt: question 1 missed, question 2
 * right. The quiz has a published alternative version, a READY simulation and a
 * stored material recommendation, so every coach option exists by default.
 */
async function fixture(opts: { final?: boolean } = {}) {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass(teacher.teacher.id);
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.student.id },
  });
  const { quiz, question } = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.teacher.id,
  });
  await prisma.question.update({
    where: { id: question.id },
    data: { feedbackIncorrect: "Add the numbers carefully." },
  });
  if (opts.final) {
    await prisma.classQuiz.update({
      where: { classId_quizId: { classId: cls.id, quizId: quiz.id } },
      data: { maxAttempts: 1 },
    });
    await prisma.quizAttempt.create({
      data: {
        studentId: student.student.id,
        classId: cls.id,
        quizId: quiz.id,
        score: 50,
        completedAt: new Date(),
      },
    });
  }
  const sim = await prisma.questionSimulation.create({
    data: {
      questionId: question.id,
      status: "READY",
      title: "Number line",
      topic: "Addition",
      learningGoal: "See sums on a number line",
      storageKey: "sims/number-line.html",
      bucket: "test",
      version: 2,
      simSpec: "A slider moves the first addend from 0 to 10.",
    },
  });
  const version = await prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Alt A",
      status: "PUBLISHED",
      variation: "NUMBERS",
      sourceSnapshot: "[]",
      objectives: "[]",
      questions: JSON.stringify([
        {
          id: "variant-q",
          sourceQuestionId: question.id,
          text: "What is 3 + 3?",
          answerMode: "SINGLE_SELECT",
          answerUnit: null,
          answerNumeric: null,
          answerTolerance: null,
          options: [
            { id: "v-a", text: "6", isCorrect: true },
            { id: "v-b", text: "7", isCorrect: false },
          ],
          solution: "Add them.",
          intentExplanation: "Same skill.",
        },
      ]),
    },
  });
  await prisma.examResult.create({
    data: {
      quizAttemptId: ATTEMPT,
      studentId: student.student.id,
      classId: cls.id,
      quizId: quiz.id,
      className: "Physics 101",
      topicName: "Arithmetic",
      quizName: "Sums",
      score: 50,
      correctCount: 1,
      totalCount: 2,
      completedAt: new Date(),
      recommendationsStatus: "READY",
      recommendations: JSON.stringify({
        items: [
          {
            materialId: "mat-1",
            materialTitle: "Arithmetic notes",
            pageRange: { start: 1, end: 2 },
            reason: "Basics of addition",
            pages: [{ pageNumber: 1, storageKey: "mat/1.png" }],
          },
        ],
        truncated: false,
        simulations: [
          {
            simulationId: sim.id,
            title: "Number line",
            topic: "Addition",
            learningGoal: "See sums on a number line",
          },
        ],
      }),
      reviewSnapshot: JSON.stringify({
        questions: [
          {
            questionId: question.id,
            text: "What is 2 + 2?",
            isCorrect: false,
            options: [
              { text: "3", isCorrect: false, selected: true },
              { text: "4", isCorrect: true, selected: false },
              { text: "5", isCorrect: false, selected: false },
            ],
          },
          {
            questionId: "q-other",
            text: "What is 1 + 1?",
            isCorrect: true,
            options: [{ text: "2", isCorrect: true, selected: true }],
          },
        ],
      }),
    },
  });
  await saveAssistantSettings("student", { enabled: true });
  // The LLM guardrail would otherwise spend a scripted model round of its own.
  await prisma.guardrailConfig.upsert({
    where: { id: "singleton" },
    update: { moderationEnabled: false, jailbreakMode: "OFF" },
    create: { id: "singleton", moderationEnabled: false, jailbreakMode: "OFF" },
  });
  asStudent(student.user.id);
  return { teacher, student, cls, quiz, question, sim, version };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockResolve.mockReset();
  mockClient.mockReset();
  resetSurfaceMemo();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/assistant/coach", () => {
  it("401s a signed-out caller and 404s a teacher", async () => {
    const f = await fixture();
    mockAuth.mockResolvedValue(null as never);
    expect((await GET_COACH(getCoach(ATTEMPT, 1))).status).toBe(401);
    asTeacher(f.teacher.user.id);
    expect((await GET_COACH(getCoach(ATTEMPT, 1))).status).toBe(404);
  });

  it("503s while the student assistant is turned off", async () => {
    await fixture();
    await saveAssistantSettings("student", { enabled: false });
    expect((await GET_COACH(getCoach(ATTEMPT, 1))).status).toBe(503);
  });

  it("404s another student's attempt, a question they got right, and out-of-range numbers alike", async () => {
    await fixture();
    const other = await createStudent();
    asStudent(other.user.id);
    expect((await GET_COACH(getCoach(ATTEMPT, 1))).status).toBe(404);

    const owner = await prisma.student.findFirstOrThrow({
      where: { id: (await prisma.examResult.findFirstOrThrow()).studentId },
    });
    asStudent(owner.userId);
    // Question 2 was answered correctly: not coachable, and indistinguishable
    // from a question that does not exist.
    expect((await GET_COACH(getCoach(ATTEMPT, 2))).status).toBe(404);
    expect((await GET_COACH(getCoach(ATTEMPT, 9))).status).toBe(404);
    expect((await GET_COACH(getCoach("no-such-attempt", 1))).status).toBe(404);
    expect((await GET_COACH(getCoach(ATTEMPT, "abc"))).status).toBe(400);
  });

  it("returns the original question and the opening, with no answer key while a retake is possible", async () => {
    await fixture();
    const res = await GET_COACH(getCoach(ATTEMPT, 1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoachSessionView;
    expect(body.question.text).toBe("What is 2 + 2?");
    expect(body.question.response).toEqual({
      kind: "choices",
      choices: [{ text: "3", imageUrl: null, imageAlt: null }],
    });
    expect(body.question.review).toBeNull();
    expect(JSON.stringify(body)).not.toContain('"4"');
    expect(body.opening).toContain("what were you thinking");
    expect(body.turns).toEqual([]);
  });

  it("includes the key and the teacher's explanation once the attempt is final", async () => {
    await fixture({ final: true });
    const body = (await (
      await GET_COACH(getCoach(ATTEMPT, 1))
    ).json()) as CoachSessionView;
    expect(body.question.review?.choices).toEqual([
      expect.objectContaining({ text: "3", selected: true, correct: false }),
      expect.objectContaining({ text: "4", selected: false, correct: true }),
      expect.objectContaining({ text: "5", selected: false, correct: false }),
    ]);
    expect(body.question.review?.explanation).toBe(
      "Add the numbers carefully.",
    );
  });
});

describe("POST /api/assistant/coach/chat", () => {
  const body = {
    message: "I added wrong",
    attemptId: ATTEMPT,
    questionNumber: 1,
  };

  it("404s an unverifiable question before anything reaches the model", async () => {
    await fixture();
    const calls = scriptModel([{ text: "hi" }]);
    const res = await POST_COACH_CHAT(
      post("/api/assistant/coach/chat", { ...body, questionNumber: 2 }),
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(await prisma.assistantConversation.count()).toBe(0);
  });

  it("413s an oversized body and 400s a malformed one", async () => {
    await fixture();
    const big = await POST_COACH_CHAT(
      post("/api/assistant/coach/chat", {
        ...body,
        message: "x".repeat(40_000),
      }),
    );
    expect(big.status).toBe(413);
    const bad = await POST_COACH_CHAT(
      post("/api/assistant/coach/chat", { message: "hi" }),
    );
    expect(bad.status).toBe(400);
  });

  it("404s a teacher", async () => {
    const f = await fixture();
    asTeacher(f.teacher.user.id);
    const res = await POST_COACH_CHAT(post("/api/assistant/coach/chat", body));
    expect(res.status).toBe(404);
  });

  it("answers with advice in plain prose, preloading the question but not the key", async () => {
    await fixture();
    const calls = scriptModel([{ text: "Walk through the addition again." }]);
    const res = await POST_COACH_CHAT(post("/api/assistant/coach/chat", body));
    expect(res.status).toBe(200);
    const out = await events(res);
    expect(out[0].type).toBe("conversation");
    expect(out.at(-1)?.type).toBe("done");
    expect(
      out
        .filter((e) => e.type === "delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Walk through the addition again.");

    const system = calls[0].messages[0].content;
    expect(system).toContain("What is 2 + 2?");
    expect(system).toContain("ANSWER KEY: withheld");
    expect(system).toContain("what were you thinking");
    expect(system).not.toContain("Add the numbers carefully.");
    // Tools offered are the coach's, not the widget's.
    const tools = (
      calls[0] as unknown as { tools: Array<{ function: { name: string } }> }
    ).tools;
    expect(tools.map((t) => t.function.name)).toEqual([
      "recommend_material",
      "explain_simulation",
      "offer_practice_question",
    ]);
  });

  it("surfaces a practice-question card, stores a reference, and rehydrates it on reopen", async () => {
    const f = await fixture();
    const calls = scriptModel([
      {
        toolCalls: [
          {
            name: "offer_practice_question",
            args: { reason: "Try one with different numbers." },
          },
        ],
      },
      { text: "Give this a go." },
    ]);
    const res = await POST_COACH_CHAT(post("/api/assistant/coach/chat", body));
    const out = await events(res);
    const action = out.find((e) => e.type === "action");
    expect(action).toMatchObject({
      type: "action",
      action: {
        kind: "practice",
        reason: "Try one with different numbers.",
        question: {
          versionId: f.version.id,
          questionId: "variant-q",
          text: "What is 3 + 3?",
          answerMode: "SINGLE_SELECT",
        },
      },
    });
    // Student-safe: no key, no solution.
    const serialized = JSON.stringify(action);
    expect(serialized).not.toContain("isCorrect");
    expect(serialized).not.toContain("Add them.");
    // The model reads a result without the card payload.
    const toolMessage = calls[1].messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).not.toContain("variant-q");

    const conversation = await prisma.assistantConversation.findFirstOrThrow();
    expect(conversation).toMatchObject({
      audience: "student",
      coachResultId: ATTEMPT,
      coachQuestionNumber: 1,
      messageCount: 2,
    });
    const messages = await prisma.assistantMessage.findMany({
      orderBy: { seq: "asc" },
    });
    expect(JSON.parse(messages[1].actions)).toEqual([
      {
        kind: "practice",
        versionId: f.version.id,
        variantQuestionId: "variant-q",
        reason: "Try one with different numbers.",
      },
    ]);

    // Reopening resumes the same conversation with the card re-rendered.
    const reopened = (await (
      await GET_COACH(getCoach(ATTEMPT, 1))
    ).json()) as CoachSessionView;
    expect(reopened.conversationId).toBe(conversation.id);
    expect(reopened.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(reopened.turns[1].actions[0]).toMatchObject({ kind: "practice" });

    // A second message continues that conversation rather than starting one.
    scriptModel([{ text: "Nice." }]);
    await (
      await POST_COACH_CHAT(
        post("/api/assistant/coach/chat", { ...body, message: "thanks" }),
      )
    ).text();
    expect(await prisma.assistantConversation.count()).toBe(1);
    expect(
      await prisma.assistantMessage.count({
        where: { conversationId: conversation.id },
      }),
    ).toBe(4);
  });

  it("does not offer practice that does not exist, and the tool fails closed", async () => {
    await fixture();
    await prisma.quizPracticeVersion.updateMany({
      data: { status: "RETIRED" },
    });
    const calls = scriptModel([
      {
        toolCalls: [
          { name: "offer_practice_question", args: { reason: "try" } },
        ],
      },
      { text: "Let's talk it through instead." },
    ]);
    const out = await events(
      await POST_COACH_CHAT(post("/api/assistant/coach/chat", body)),
    );
    expect(out.some((e) => e.type === "action")).toBe(false);
    expect(calls[0].messages[0].content).toContain(
      "Practice question: none available",
    );
    const toolMessage = calls[1].messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).toContain(
      "No alternative-version question exists",
    );
  });

  it("recommends a stored material and refuses a number outside the list", async () => {
    await fixture();
    scriptModel([
      {
        toolCalls: [
          {
            name: "recommend_material",
            args: { materialNumber: 7, reason: "r" },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "recommend_material",
            args: { materialNumber: 1, reason: "Review the addition basics." },
          },
        ],
      },
      { text: "Read this first." },
    ]);
    const out = await events(
      await POST_COACH_CHAT(post("/api/assistant/coach/chat", body)),
    );
    const actions = out.filter((e) => e.type === "action");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: {
        kind: "material",
        reason: "Review the addition basics.",
        recommendation: {
          materialId: "mat-1",
          materialTitle: "Arithmetic notes",
          pages: [{ pageNumber: 1, imageUrl: "https://signed.test/mat/1.png" }],
        },
      },
    });
  });

  it("shows a simulation how-to only for a simulation the student can open", async () => {
    const f = await fixture();
    scriptModel([
      {
        toolCalls: [
          {
            name: "explain_simulation",
            args: {
              simulationId: f.sim.id,
              goal: "See how the sum changes.",
              steps: ["Move the slider to 2.", "Move it to 5."],
              observe: "Watch the total.",
            },
          },
        ],
      },
      { text: "Try it." },
    ]);
    const out = await events(
      await POST_COACH_CHAT(post("/api/assistant/coach/chat", body)),
    );
    expect(out.find((e) => e.type === "action")).toMatchObject({
      action: {
        kind: "simulation",
        simulation: {
          simulationId: f.sim.id,
          title: "Number line",
          version: 2,
        },
        steps: ["Move the slider to 2.", "Move it to 5."],
      },
    });

    // Un-enrolled students (e.g. removed from the class) lose the offer, and
    // a made-up id never works.
    await prisma.classEnrollment.deleteMany();
    const calls = scriptModel([
      {
        toolCalls: [
          {
            name: "explain_simulation",
            args: {
              simulationId: f.sim.id,
              goal: "g",
              steps: ["a", "b"],
              observe: "o",
            },
          },
        ],
      },
      { text: "ok" },
    ]);
    const second = await events(
      await POST_COACH_CHAT(post("/api/assistant/coach/chat", body)),
    );
    expect(second.some((e) => e.type === "action")).toBe(false);
    expect(calls[1].messages.find((m) => m.role === "tool")!.content).toContain(
      "not available to this student",
    );
  });

  it("keeps coach conversations out of the assistant widget's history and cannot be appended to from it", async () => {
    await fixture();
    scriptModel([{ text: "Tell me more." }]);
    await (
      await POST_COACH_CHAT(post("/api/assistant/coach/chat", body))
    ).text();
    const coachConversation =
      await prisma.assistantConversation.findFirstOrThrow();

    const list = await (await GET_CONVERSATIONS()).json();
    expect(list.conversations).toEqual([]);

    scriptModel([{ text: "General answer." }]);
    await (
      await POST_CHAT(
        post("/api/assistant/chat", {
          message: "hello",
          conversationId: coachConversation.id,
        }),
      )
    ).text();
    expect(
      await prisma.assistantMessage.count({
        where: { conversationId: coachConversation.id },
      }),
    ).toBe(2);
    expect(await prisma.assistantConversation.count()).toBe(2);
  });

  it("runs the assistant's guardrails: a blocked message never reaches the model", async () => {
    await fixture();
    vi.mocked(guardChatTurn).mockResolvedValueOnce({
      blocked: true,
      message: "That message was blocked.",
      eventId: "evt-1",
    } as never);
    const calls = scriptModel([{ text: "should not run" }]);
    const out = await events(
      await POST_COACH_CHAT(post("/api/assistant/coach/chat", body)),
    );
    expect(out.at(-1)).toEqual({
      type: "error",
      message: "That message was blocked.",
      guardrailEventId: "evt-1",
    });
    expect(calls).toHaveLength(0);
    expect(vi.mocked(guardChatTurn)).toHaveBeenCalledWith(
      "I added wrong",
      expect.anything(),
      expect.objectContaining({ surface: "assistant_chat" }),
    );
    expect(await prisma.assistantMessage.count()).toBe(0);
  });
});

describe("POST /api/assistant/coach/practice", () => {
  const answer = (f: { version: { id: string } }, over: object = {}) =>
    post("/api/assistant/coach/practice", {
      attemptId: ATTEMPT,
      questionNumber: 1,
      versionId: f.version.id,
      questionId: "variant-q",
      selectedOptionId: "v-a",
      ...over,
    });

  it("grades right and wrong answers and returns nothing else", async () => {
    const f = await fixture();
    const right = await POST_PRACTICE(answer(f));
    expect(right.status).toBe(200);
    expect((await right.json()) as CoachPracticeResult).toEqual({
      correct: true,
    });
    const wrong = await POST_PRACTICE(answer(f, { selectedOptionId: "v-b" }));
    expect(await wrong.json()).toEqual({ correct: false });
    // Stateless: no practice attempt, no graded attempt, no grade change.
    expect(await prisma.quizPracticeAttempt.count()).toBe(0);
    expect(await prisma.quizProgress.count()).toBe(0);
  });

  it("404s an unknown version, a mismatched question, an invalid choice and a retired version", async () => {
    const f = await fixture();
    expect((await POST_PRACTICE(answer(f, { versionId: "nope" }))).status).toBe(
      404,
    );
    expect(
      (await POST_PRACTICE(answer(f, { questionId: "other" }))).status,
    ).toBe(404);
    expect(
      (await POST_PRACTICE(answer(f, { selectedOptionId: "not-an-option" })))
        .status,
    ).toBe(404);
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "RETIRED" },
    });
    expect((await POST_PRACTICE(answer(f))).status).toBe(404);
  });

  it("404s a question the student answered correctly or an attempt that is not theirs", async () => {
    const f = await fixture();
    expect((await POST_PRACTICE(answer(f, { questionNumber: 2 }))).status).toBe(
      404,
    );
    const other = await createStudent();
    asStudent(other.user.id);
    expect((await POST_PRACTICE(answer(f))).status).toBe(404);
  });

  it("follows the practice feature's access rules: enrollment and an open assignment", async () => {
    const f = await fixture();
    await prisma.classQuiz.updateMany({ data: { published: false } });
    expect((await POST_PRACTICE(answer(f))).status).toBe(404);
  });

  it("validates and bounds the body", async () => {
    const f = await fixture();
    expect((await POST_PRACTICE(answer(f, { questionNumber: 0 }))).status).toBe(
      400,
    );
    const big = await POST_PRACTICE(
      answer(f, { numericValue: "9".repeat(20_000) }),
    );
    expect(big.status).toBe(413);
    mockAuth.mockResolvedValue(null as never);
    expect((await POST_PRACTICE(answer(f))).status).toBe(401);
  });
});
