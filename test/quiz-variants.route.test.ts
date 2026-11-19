import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({
  enqueueQuizVariant: vi.fn(),
  enqueueExamResult: vi.fn(),
  enqueueVariantEmails: vi.fn(),
}));
vi.mock("@/lib/quiz-variants-engine", () => ({
  generateQuizVariantSample: vi.fn(),
}));
import { auth } from "@/lib/auth";
import { generateQuizVariantSample } from "@/lib/quiz-variants-engine";
import { POST as sample } from "@/app/api/quizzes/[id]/variants/sample/route";
import { enqueueExamResult, enqueueQuizVariant } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import {
  GET as versions,
  POST as generate,
  PATCH as change,
} from "@/app/api/quizzes/[id]/variants/route";
import {
  GET as history,
  POST as start,
  PATCH as submit,
} from "@/app/api/quiz/practice/route";
import {
  resetDb,
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
} from "./db";
function req(body: unknown) {
  return new NextRequest("http://localhost/api/quiz/practice", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function login(id: string, role: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id, role } } as never);
}
beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
});
async function fixture() {
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
  const questions = [
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
      solution: "3+3=6",
      intentExplanation: "Addition",
    },
  ];
  const version = await prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Version A",
      status: "PUBLISHED",
      variation: "NUMBERS",
      sourceSnapshot: JSON.stringify([{ ...questions[0], id: question.id }]),
      objectives: JSON.stringify([
        { sourceQuestionId: question.id, objective: "Add whole numbers." },
      ]),
      questions: JSON.stringify(questions),
      validation: "[]",
    },
  });
  login(student.user.id, "STUDENT");
  return {
    teacher,
    student,
    cls,
    quiz,
    question,
    version,
    questions,
    input: { classId: cls.id, quizId: quiz.id },
  };
}
describe("alternative practice lifecycle", () => {
  it("resumes identical content, ignores source edits, scores once, records a retake, and leaves grades alone", async () => {
    const f = await fixture();
    const first = await (await start(req(f.input))).json();
    expect(first.questions[0].options[0]).not.toHaveProperty("isCorrect");
    expect(first.questions[0]).not.toHaveProperty("solution");
    await prisma.question.update({
      where: { id: f.question.id },
      data: { text: "Edited original" },
    });
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "RETIRED" },
    });
    expect(await (await start(req(f.input))).json()).toEqual(first);
    const answers = {
      attemptId: first.attemptId,
      answers: [{ questionId: "variant-q", selectedOptionIds: ["v-a"] }],
    };
    const submitted = await (await submit(req(answers))).json();
    expect(submitted).toEqual({
      score: 100,
      incorrectQuestionIds: [],
      quizAttemptId: first.quizAttemptId,
    });
    expect((await submit(req(answers))).status).toBe(409);
    // Recorded as a retake through the ordinary attempt/result pipeline...
    const retake = await prisma.quizAttempt.findUniqueOrThrow({
      where: { id: first.quizAttemptId },
      include: { answers: true },
    });
    expect(retake).toMatchObject({
      studentId: f.student.student.id,
      classId: f.cls.id,
      quizId: f.quiz.id,
      practiceVersionId: f.version.id,
      practiceVersionName: "Version A",
      score: 100,
    });
    expect(retake.completedAt).not.toBeNull();
    expect(retake.answers).toMatchObject([
      {
        questionId: f.question.id,
        selectedOptionId: null,
        selectedOptionIds: JSON.stringify(["v-a"]),
        isCorrect: true,
      },
    ]);
    const result = await prisma.examResult.findUniqueOrThrow({
      where: { quizAttemptId: first.quizAttemptId },
    });
    expect(result).toMatchObject({
      practiceVersionName: "Version A",
      excludedCount: 0,
      score: 100,
      correctCount: 1,
      totalCount: 1,
      quizName: f.quiz.name,
    });
    expect(JSON.parse(result.reviewSnapshot).questions[0]).toMatchObject({
      questionId: f.question.id,
      text: "What is 3 + 3?",
      isCorrect: true,
    });
    expect(enqueueExamResult).toHaveBeenCalledWith(result.id);
    // ...but it never touches graded progress.
    expect(await prisma.quizProgress.count()).toBe(0);
    await prisma.quiz.delete({ where: { id: f.quiz.id } });
    expect(
      (
        await prisma.quizPracticeAttempt.findUniqueOrThrow({
          where: { id: first.attemptId },
        })
      ).score,
    ).toBe(100);
  });
  it("prefers unseen published versions and archives practice history", async () => {
    const f = await fixture();
    const a = await (await start(req(f.input))).json();
    await submit(req({ attemptId: a.attemptId, answers: [] }));
    expect(await prisma.quizAttempt.count()).toBe(1);
    await prisma.quizPracticeVersion.create({
      data: {
        quizId: f.quiz.id,
        name: "Version B",
        status: "PUBLISHED",
        variation: "NUMBERS",
        sourceSnapshot: "[]",
        objectives: "[]",
        questions: JSON.stringify(f.questions),
      },
    });
    const b = await (await start(req(f.input))).json();
    expect(b.versionName).toBe("Version B");
    const response = await history(
      new NextRequest(
        `http://localhost/api/quiz/practice?${new URLSearchParams(f.input)}`,
      ),
    );
    const data = await response.json();
    expect(data.attempts).toHaveLength(2);
    expect(data.attempts[0]).not.toHaveProperty("questions");
    expect(
      data.attempts.find((x: { id: string }) => x.id === a.attemptId).score,
    ).toBe(0);
  });
  it("blocks drafts, unauthorized access, closed windows, and cross-student submissions", async () => {
    const f = await fixture();
    const a = await (await start(req(f.input))).json();
    const other = await createStudent();
    login(other.user.id, "STUDENT");
    expect((await start(req(f.input))).status).toBe(403);
    expect(
      (await submit(req({ attemptId: a.attemptId, answers: [] }))).status,
    ).toBe(404);
    expect((await versions(req({}), ctx(f.quiz.id))).status).toBe(404);
    login(f.student.user.id, "STUDENT");
    await submit(req({ attemptId: a.attemptId, answers: [] }));
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "REVIEW" },
    });
    expect((await start(req(f.input))).status).toBe(404);
    await prisma.classQuiz.update({
      where: { classId_quizId: f.input },
      data: { availableUntil: new Date(0) },
    });
    expect((await start(req(f.input))).status).toBe(403);
  });
  it("enforces a single active attempt under concurrent starts", async () => {
    const f = await fixture();
    const responses = await Promise.all([
      start(req(f.input)),
      start(req(f.input)),
    ]);
    const payloads = await Promise.all(responses.map((r) => r.json()));
    expect(payloads[0].attemptId).toBe(payloads[1].attemptId);
    expect(await prisma.quizPracticeAttempt.count()).toBe(1);
  });
  it("rejects forged and duplicate questions and choices", async () => {
    const f = await fixture();
    const a = await (await start(req(f.input))).json();
    for (const answers of [
      [{ questionId: "foreign" }],
      [{ questionId: "variant-q" }, { questionId: "variant-q" }],
      [{ questionId: "variant-q", selectedOptionIds: ["foreign"] }],
    ]) {
      expect(
        (await submit(req({ attemptId: a.attemptId, answers }))).status,
      ).toBe(400);
    }
    expect(
      (
        await prisma.quizPracticeAttempt.findUniqueOrThrow({
          where: { id: a.attemptId },
        })
      ).completedAt,
    ).toBeNull();
  });
});
describe("teacher variant controls", () => {
  it("queues only owned valid source quizzes with confirmed objectives", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const input = {
      name: "New practice",
      variation: "NUMBERS",
      objectives: [
        {
          sourceQuestionId: f.question.id,
          objective: "Add whole numbers with one step.",
        },
      ],
    };
    const created = await generate(req(input), ctx(f.quiz.id));
    expect(created.status).toBe(202);
    expect(enqueueQuizVariant).toHaveBeenCalledOnce();
    const row = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: (await created.json()).id },
    });
    expect(JSON.parse(row.sourceSnapshot)[0].text).toBe(f.question.text);
    expect((await generate(req(input), ctx(f.quiz.id))).status).toBe(409);
    const other = await createTeacher();
    login(other.user.id, "TEACHER");
    expect((await generate(req(input), ctx(f.quiz.id))).status).toBe(404);
  });
  it("publishes only reviewed versions and prevents editing published content", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    expect(
      (
        await change(
          req({
            versionId: f.version.id,
            action: "edit",
            questions: f.questions,
          }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(409);
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "GENERATING" },
    });
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "publish" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(409);
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "REVIEW" },
    });
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "publish" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "retire" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(200);
  });
  it("requires revalidation of edited drafts and persists queue failure for retry", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "REVIEW" },
    });
    vi.mocked(enqueueQuizVariant).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(
      (
        await change(
          req({
            versionId: f.version.id,
            action: "edit",
            questions: f.questions,
          }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: f.version.id },
        })
      ).status,
    ).toBe("FAILED");
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "retry" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(202);
  });
});

it("queues four drafts per mode atomically, preserving restrictions and requiring review", async () => {
  const f = await fixture();
  login(f.teacher.user.id, "TEACHER");
  const response = await generate(
    req({
      name: "Preview",
      variation: "NUMBERS",
      count: 4,
      bothModes: true,
      objectives: [
        {
          sourceQuestionId: f.question.id,
          objective: "Use only whole numbers.",
        },
      ],
    }),
    ctx(f.quiz.id),
  );
  expect(response.status).toBe(202);
  const data = await response.json();
  expect(data.ids).toHaveLength(8);
  const rows = await prisma.quizPracticeVersion.findMany({
    where: { id: { in: data.ids } },
  });
  expect(rows.filter((r) => r.variation === "NUMBERS")).toHaveLength(4);
  expect(rows.filter((r) => r.variation === "CONTEXT")).toHaveLength(4);
  expect(rows.every((r) => r.status === "QUEUED")).toBe(true);
  expect(enqueueQuizVariant).toHaveBeenCalledTimes(8);
  const blocked = await generate(
    req({
      name: "Another",
      variation: "NUMBERS",
      count: 4,
      objectives: [
        {
          sourceQuestionId: f.question.id,
          objective: "Use only whole numbers.",
        },
      ],
    }),
    ctx(f.quiz.id),
  );
  expect(blocked.status).toBe(409);
});

it("records individual queue failures without losing the rest of the preview batch", async () => {
  const f = await fixture();
  login(f.teacher.user.id, "TEACHER");
  vi.mocked(enqueueQuizVariant).mockImplementationOnce(() => {
    throw new Error("Queue unavailable");
  });
  const response = await generate(
    req({
      name: "Preview",
      variation: "CONTEXT",
      count: 4,
      objectives: [
        {
          sourceQuestionId: f.question.id,
          objective: "Use only whole numbers.",
        },
      ],
    }),
    ctx(f.quiz.id),
  );
  expect(response.status).toBe(503);
  const drafts = await prisma.quizPracticeVersion.findMany({
    where: { quizId: f.quiz.id, id: { not: f.version.id } },
  });
  expect(drafts).toHaveLength(4);
  expect(drafts.filter((v) => v.status === "FAILED")).toHaveLength(1);
  expect(drafts.filter((v) => v.status === "QUEUED")).toHaveLength(3);
  expect(enqueueQuizVariant).toHaveBeenCalledTimes(4);
});

describe("generation rounds", () => {
  const objectives = (questionId: string) => [
    { sourceQuestionId: questionId, objective: "Use only whole numbers." },
  ];
  it("queues a 2×2 round, then two more into the same round while it runs", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const round = await (
      await generate(
        req({
          name: "Version",
          variation: "NUMBERS",
          count: 2,
          bothModes: true,
          purpose: "STANDALONE",
          objectives: objectives(f.question.id),
        }),
        ctx(f.quiz.id),
      )
    ).json();
    expect(round.ids).toHaveLength(4);
    const more = await generate(
      req({
        name: "Version",
        variation: "CONTEXT",
        count: 2,
        batchId: round.batchId,
        objectives: objectives(f.question.id),
      }),
      ctx(f.quiz.id),
    );
    expect(more.status).toBe(202);
    const rows = await prisma.quizPracticeVersion.findMany({
      where: { batchId: round.batchId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(6);
    // "Two more" inherit the round's purpose and continue its numbering.
    expect(rows.every((r) => r.purpose === "STANDALONE")).toBe(true);
    expect(
      rows.filter((r) => r.variation === "CONTEXT").map((r) => r.name),
    ).toEqual([
      "Version · Context 1",
      "Version · Context 2",
      "Version · Context 3",
      "Version · Context 4",
    ]);
    const unknown = await generate(
      req({
        name: "Version",
        variation: "CONTEXT",
        count: 2,
        batchId: "missing",
        objectives: objectives(f.question.id),
      }),
      ctx(f.quiz.id),
    );
    expect(unknown.status).toBe(404);
    const crowded = await generate(
      req({
        name: "Version",
        variation: "CONTEXT",
        count: 4,
        bothModes: true,
        batchId: round.batchId,
        objectives: objectives(f.question.id),
      }),
      ctx(f.quiz.id),
    );
    expect(crowded.status).toBe(409);
  });

  it("revises a draft with feedback into a fresh queued draft", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "REVIEW", batchId: "round" },
    });
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "revise" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(400);
    const revised = await change(
      req({
        versionId: f.version.id,
        action: "revise",
        feedback: "Use smaller numbers.",
      }),
      ctx(f.quiz.id),
    );
    expect(revised.status).toBe(202);
    const next = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: (await revised.json()).id },
    });
    expect(next).toMatchObject({
      status: "QUEUED",
      batchId: "round",
      feedback: "Use smaller numbers.",
      revisedFromId: f.version.id,
    });
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: f.version.id },
        })
      ).status,
    ).toBe("DISCARDED");
    const listed = await (await versions(req({}), ctx(f.quiz.id))).json();
    expect(listed.versions.map((v: { id: string }) => v.id)).toEqual([next.id]);
  });

  it("saves a reviewed draft as a standalone exam in the source quiz's scope", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    await prisma.question.update({
      where: { id: f.question.id },
      data: { points: 3, difficultyLevel: "ADVANCED" },
    });
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "REVIEW" },
    });
    const saved = await change(
      req({ versionId: f.version.id, action: "standalone" }),
      ctx(f.quiz.id),
    );
    expect(saved.status).toBe(200);
    const { quizId } = await saved.json();
    const quiz = await prisma.quiz.findUniqueOrThrow({
      where: { id: quizId },
      include: { questions: { include: { options: true } } },
    });
    expect(quiz).toMatchObject({
      teacherId: f.teacher.teacher.id,
      sourceQuizId: f.quiz.id,
      name: `${f.quiz.name} (new version 1)`,
    });
    expect(quiz.questions).toHaveLength(1);
    expect(quiz.questions[0]).toMatchObject({
      text: "What is 3 + 3?",
      points: 3,
      difficultyLevel: "ADVANCED",
      feedbackGeneral: "3+3=6",
    });
    expect(quiz.questions[0].options.map((o) => [o.text, o.isCorrect])).toEqual(
      [
        ["6", true],
        ["7", false],
      ],
    );
    const listed = await (await versions(req({}), ctx(f.quiz.id))).json();
    expect(listed.versions[0]).toMatchObject({
      status: "STANDALONE",
      standaloneQuiz: { id: quizId },
    });
    // Saving twice must not create a second exam.
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "standalone" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(409);
    expect(
      await prisma.quiz.count({ where: { sourceQuizId: f.quiz.id } }),
    ).toBe(1);
  });

  it("regenerates failed drafts from scratch but keeps teacher edits on retry", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "FAILED" },
    });
    await change(
      req({ versionId: f.version.id, action: "retry" }),
      ctx(f.quiz.id),
    );
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: f.version.id },
        })
      ).questions,
    ).toBe("[]");
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: {
        status: "FAILED",
        teacherEdited: true,
        questions: JSON.stringify(f.questions),
      },
    });
    await change(
      req({ versionId: f.version.id, action: "retry" }),
      ctx(f.quiz.id),
    );
    expect(
      JSON.parse(
        (
          await prisma.quizPracticeVersion.findUniqueOrThrow({
            where: { id: f.version.id },
          })
        ).questions,
      ),
    ).toEqual(f.questions);
  });
});

it("lets admins inspect, generate and save teacher quiz variants in the teacher's scope", async () => {
  const f = await fixture();
  login(f.teacher.user.id, "ADMIN");
  const listed = await versions(req({}), ctx(f.quiz.id));
  expect(listed.status).toBe(200);
  expect((await listed.json()).versions[0].questions).toEqual(f.questions);
  const generated = await generate(
    req({
      name: "Admin round",
      variation: "NUMBERS",
      objectives: [
        {
          sourceQuestionId: f.question.id,
          objective: "Add whole numbers in one step.",
        },
      ],
    }),
    ctx(f.quiz.id),
  );
  expect(generated.status).toBe(202);
  expect(enqueueQuizVariant).toHaveBeenCalledOnce();
  await prisma.quizPracticeVersion.update({
    where: { id: f.version.id },
    data: { status: "REVIEW" },
  });
  const saved = await change(
    req({ versionId: f.version.id, action: "standalone" }),
    ctx(f.quiz.id),
  );
  expect(saved.status).toBe(200);
  const { quizId } = await saved.json();
  expect(
    await prisma.quiz.findUniqueOrThrow({ where: { id: quizId } }),
  ).toMatchObject({
    teacherId: f.teacher.teacher.id,
    sourceQuizId: f.quiz.id,
  });
});

it("keeps other teachers, researchers and students out of variant management", async () => {
  const f = await fixture();
  const other = await createTeacher();
  for (const [id, role] of [
    [other.user.id, "TEACHER"],
    [f.student.user.id, "STUDENT"],
    [f.teacher.user.id, "RESEARCHER"],
  ]) {
    login(id, role);
    expect((await versions(req({}), ctx(f.quiz.id))).status).toBe(404);
    expect((await generate(req({}), ctx(f.quiz.id))).status).toBe(404);
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "retire" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(404);
  }
});

describe("redesigned generation rounds", () => {
  const objectives = (questionId: string) => [
    {
      sourceQuestionId: questionId,
      objective: "Add whole numbers in one step.",
    },
  ];
  const sampleFor = (questionId: string) => ({
    question: {
      id: "s-q",
      sourceQuestionId: questionId,
      text: "What is 5 + 5?",
      answerMode: "SINGLE_SELECT",
      answerUnit: null,
      answerNumeric: null,
      answerTolerance: null,
      options: [
        { id: "s-a", text: "10", isCorrect: true },
        { id: "s-b", text: "11", isCorrect: false },
      ],
      solution: "5+5=10",
      intentExplanation: "Addition",
    },
    check: {
      sourceQuestionId: questionId,
      intentPreserved: true,
      unambiguous: true,
      answerNumeric: null,
      correctOptionId: "s-a",
      explanation: "5+5=10",
    },
  });
  async function startRound(
    f: Awaited<ReturnType<typeof fixture>>,
    extra: Record<string, unknown> = {},
  ) {
    const response = await generate(
      req({ mix: "2-2", objectives: objectives(f.question.id), ...extra }),
      ctx(f.quiz.id),
    );
    expect(response.status).toBe(202);
    return response.json();
  }

  it.each([
    ["4-0", 4, 0],
    ["2-2", 2, 2],
    ["0-4", 0, 4],
  ])(
    "queues a %s mix with ordered slots and batch tracking",
    async (mix, n, c) => {
      const f = await fixture();
      login(f.teacher.user.id, "TEACHER");
      const response = await generate(
        new NextRequest("https://app.example/api/quizzes/x/variants", {
          method: "POST",
          body: JSON.stringify({ mix, objectives: objectives(f.question.id) }),
        }),
        ctx(f.quiz.id),
      );
      expect(response.status).toBe(202);
      const data = await response.json();
      const rows = await prisma.quizPracticeVersion.findMany({
        where: { batchId: data.batchId },
        orderBy: { slotIndex: "asc" },
      });
      expect(rows.map((r) => r.slotIndex)).toEqual([0, 1, 2, 3]);
      expect(rows.filter((r) => r.variation === "NUMBERS")).toHaveLength(n);
      expect(rows.filter((r) => r.variation === "CONTEXT")).toHaveLength(c);
      expect(rows[0].name).toMatch(/^Version · (Numbers|Context) 1$/);
      expect(
        rows.every(
          (r) =>
            r.requestedById === f.teacher.user.id &&
            r.totalCount === 1 &&
            r.status === "QUEUED",
        ),
      ).toBe(true);
      expect(enqueueQuizVariant).toHaveBeenCalledTimes(4);
      expect(
        await prisma.quizVariantBatchState.findUniqueOrThrow({
          where: { batchId: data.batchId },
        }),
      ).toMatchObject({
        quizId: f.quiz.id,
        requestedById: f.teacher.user.id,
        recipientRole: "TEACHER",
        appOrigin: "https://app.example",
        cycle: 1,
        kind: "INITIAL",
      });
    },
  );

  it("continues slot numbering when appending to a round", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const round = await startRound(f);
    const more = await generate(
      req({
        name: "Version",
        variation: "NUMBERS",
        count: 2,
        batchId: round.batchId,
        objectives: objectives(f.question.id),
      }),
      ctx(f.quiz.id),
    );
    expect(more.status).toBe(202);
    const rows = await prisma.quizPracticeVersion.findMany({
      where: { batchId: round.batchId },
      orderBy: { slotIndex: "asc" },
    });
    expect(rows.map((r) => r.slotIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      (
        await prisma.quizVariantBatchState.findUniqueOrThrow({
          where: { batchId: round.batchId },
        })
      ).cycle,
    ).toBe(2);
  });

  it("seeds verified modal samples into the first draft of each mode", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const good = sampleFor(f.question.id);
    const bad = {
      ...good,
      check: { ...good.check, correctOptionId: "s-b" },
    };
    const round = await startRound(f, {
      seedSamples: { numbersSample: good, contextSample: bad },
    });
    const rows = await prisma.quizPracticeVersion.findMany({
      where: { batchId: round.batchId },
      orderBy: { slotIndex: "asc" },
    });
    const seeded = rows.filter((r) => r.questions !== "[]");
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      variation: "NUMBERS",
      slotIndex: 0,
      status: "QUEUED",
      completedCount: 1,
    });
    expect(JSON.parse(seeded[0].questions)).toEqual([good.question]);
    expect(JSON.parse(seeded[0].validation!)).toEqual([good.check]);
    expect(enqueueQuizVariant).toHaveBeenCalledTimes(4);
  });

  it("previews one verified sample per mode for the first numeric-style question", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const preview = {
      sourceQuestionId: f.question.id,
      numbersSample: sampleFor(f.question.id),
      contextSample: sampleFor(f.question.id),
      aiModel: "openai/gpt-test",
    };
    vi.mocked(generateQuizVariantSample).mockResolvedValue(preview as never);
    const response = await sample(req({}), ctx(f.quiz.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
    const args = vi.mocked(generateQuizVariantSample).mock.calls[0][0];
    expect(args.quizId).toBe(f.quiz.id);
    expect(args.source).toMatchObject({
      id: f.question.id,
      text: f.question.text,
    });
    expect(args.objective.length).toBeGreaterThanOrEqual(10);
    expect(
      (await sample(req({ questionId: "missing" }), ctx(f.quiz.id))).status,
    ).toBe(404);
    vi.mocked(generateQuizVariantSample).mockRejectedValueOnce(
      new Error("Independent answer disagrees"),
    );
    expect((await sample(req({}), ctx(f.quiz.id))).status).toBe(502);
    const other = await createTeacher();
    login(other.user.id, "TEACHER");
    expect((await sample(req({}), ctx(f.quiz.id))).status).toBe(404);
  });

  it("refuses samples for quizzes that cannot be varied", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    await prisma.question.update({
      where: { id: f.question.id },
      data: { answerMode: "MULTI_SELECT" },
    });
    expect((await sample(req({}), ctx(f.quiz.id))).status).toBe(400);
    expect(generateQuizVariantSample).not.toHaveBeenCalled();
  });

  it("filters the list by round and reports progress fields", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const round = await startRound(f);
    const response = await versions(
      new NextRequest(
        `http://localhost/api/quizzes/${f.quiz.id}/variants?batchId=${round.batchId}`,
      ),
      ctx(f.quiz.id),
    );
    const data = await response.json();
    expect(data.quizName).toBe(f.quiz.name);
    expect(data.versions).toHaveLength(4);
    expect(data.versions[0]).toMatchObject({
      batchId: round.batchId,
      completedCount: 0,
      totalCount: 1,
      questionFeedback: null,
    });
    expect(
      data.versions.map((v: { slotIndex: number }) => v.slotIndex).sort(),
    ).toEqual([0, 1, 2, 3]);
  });

  async function reviewedRound(f: Awaited<ReturnType<typeof fixture>>) {
    const round = await startRound(f);
    const { question, check } = sampleFor(f.question.id);
    await prisma.quizPracticeVersion.updateMany({
      where: { batchId: round.batchId },
      data: {
        status: "REVIEW",
        questions: JSON.stringify([question]),
        validation: JSON.stringify([check]),
        completedCount: 1,
      },
    });
    return prisma.quizPracticeVersion.findMany({
      where: { batchId: round.batchId },
      orderBy: { slotIndex: "asc" },
    });
  }

  it("revises several drafts atomically with per-question reasons and one new cycle", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const drafts = await reviewedRound(f);
    const batchId = drafts[0].batchId!;
    vi.mocked(enqueueQuizVariant).mockClear();
    const response = await change(
      req({
        action: "revise_batch",
        batchId,
        revisions: [
          {
            versionId: drafts[0].id,
            questionRevisions: [
              {
                sourceQuestionId: f.question.id,
                reason: "Too similar to the original.",
              },
            ],
          },
          { versionId: drafts[2].id, feedback: "Use a sports context." },
        ],
      }),
      ctx(f.quiz.id),
    );
    expect(response.status).toBe(202);
    const data = await response.json();
    expect(data).toMatchObject({ batchId, status: "QUEUED" });
    expect(data.ids).toHaveLength(2);
    expect(enqueueQuizVariant).toHaveBeenCalledTimes(2);
    const replacements = await prisma.quizPracticeVersion.findMany({
      where: { id: { in: data.ids } },
      orderBy: { slotIndex: "asc" },
    });
    expect(replacements[0]).toMatchObject({
      status: "QUEUED",
      slotIndex: drafts[0].slotIndex,
      name: drafts[0].name,
      variation: drafts[0].variation,
      revisedFromId: drafts[0].id,
      requestedById: f.teacher.user.id,
      totalCount: 1,
      completedCount: 0,
    });
    expect(JSON.parse(replacements[0].questionFeedback!)).toEqual([
      {
        sourceQuestionId: f.question.id,
        reason: "Too similar to the original.",
      },
    ]);
    expect(replacements[1]).toMatchObject({
      slotIndex: drafts[2].slotIndex,
      feedback: "Use a sports context.",
      questionFeedback: null,
    });
    const discarded = await prisma.quizPracticeVersion.findMany({
      where: { id: { in: [drafts[0].id, drafts[2].id] } },
    });
    expect(discarded.every((d) => d.status === "DISCARDED")).toBe(true);
    expect(
      await prisma.quizVariantBatchState.findUniqueOrThrow({
        where: { batchId },
      }),
    ).toMatchObject({ cycle: 2, kind: "REVISION" });
  });

  it("rejects stale, foreign or malformed batch revisions without partial changes", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const drafts = await reviewedRound(f);
    const batchId = drafts[0].batchId!;
    const revise = (revisions: unknown[]) =>
      change(
        req({ action: "revise_batch", batchId, revisions }),
        ctx(f.quiz.id),
      );
    expect(
      (
        await revise([
          {
            versionId: drafts[0].id,
            questionRevisions: [
              { sourceQuestionId: "foreign", reason: "Nope nope" },
            ],
          },
        ])
      ).status,
    ).toBe(400);
    expect((await revise([{ versionId: drafts[0].id }])).status).toBe(400);
    expect(
      (await revise([{ versionId: f.version.id, feedback: "Other round" }]))
        .status,
    ).toBe(404);
    await prisma.quizPracticeVersion.update({
      where: { id: drafts[1].id },
      data: { status: "PUBLISHED" },
    });
    expect(
      (
        await revise([
          { versionId: drafts[0].id, feedback: "Smaller numbers" },
          { versionId: drafts[1].id, feedback: "Smaller numbers" },
        ])
      ).status,
    ).toBe(409);
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: drafts[0].id },
        })
      ).status,
    ).toBe("REVIEW");
    expect(
      (
        await prisma.quizVariantBatchState.findUniqueOrThrow({
          where: { batchId },
        })
      ).cycle,
    ).toBe(1);
  });

  it("revises one draft's flagged question and bumps the round cycle", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const drafts = await reviewedRound(f);
    const response = await change(
      req({
        versionId: drafts[1].id,
        action: "revise",
        questionRevisions: [
          { sourceQuestionId: f.question.id, reason: "Distractors are weak." },
        ],
      }),
      ctx(f.quiz.id),
    );
    expect(response.status).toBe(202);
    const next = await prisma.quizPracticeVersion.findUniqueOrThrow({
      where: { id: (await response.json()).id },
    });
    expect(next).toMatchObject({
      slotIndex: drafts[1].slotIndex,
      revisedFromId: drafts[1].id,
      feedback: null,
    });
    expect(JSON.parse(next.questionFeedback!)[0].reason).toBe(
      "Distractors are weak.",
    );
    expect(
      (
        await prisma.quizVariantBatchState.findUniqueOrThrow({
          where: { batchId: drafts[1].batchId! },
        })
      ).cycle,
    ).toBe(2);
  });

  it("publishes every reviewed draft of a round only while the quiz is unchanged", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    const drafts = await reviewedRound(f);
    const batchId = drafts[0].batchId!;
    await prisma.quizPracticeVersion.update({
      where: { id: drafts[3].id },
      data: { status: "FAILED" },
    });
    await prisma.question.update({
      where: { id: f.question.id },
      data: { text: "What is 2 + 3?" },
    });
    const stale = await change(
      req({ action: "publish_batch", batchId }),
      ctx(f.quiz.id),
    );
    expect(stale.status).toBe(409);
    expect(
      await prisma.quizPracticeVersion.count({
        where: { batchId, status: "PUBLISHED" },
      }),
    ).toBe(0);
    await prisma.question.update({
      where: { id: f.question.id },
      data: { text: "What is 2 + 2?" },
    });
    const published = await change(
      req({ action: "publish_batch", batchId }),
      ctx(f.quiz.id),
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({
      publishedCount: 3,
      status: "PUBLISHED",
    });
    expect(
      (
        await prisma.quizPracticeVersion.findUniqueOrThrow({
          where: { id: drafts[3].id },
        })
      ).status,
    ).toBe("FAILED");
    expect(
      (await change(req({ action: "publish_batch", batchId }), ctx(f.quiz.id)))
        .status,
    ).toBe(409);
  });

  it("refuses to publish a single draft whose questions no longer match the quiz", async () => {
    const f = await fixture();
    login(f.teacher.user.id, "TEACHER");
    await prisma.quizPracticeVersion.update({
      where: { id: f.version.id },
      data: { status: "REVIEW" },
    });
    await prisma.question.update({
      where: { id: f.question.id },
      data: { answerMode: "NUMERIC" },
    });
    expect(
      (
        await change(
          req({ versionId: f.version.id, action: "publish" }),
          ctx(f.quiz.id),
        )
      ).status,
    ).toBe(409);
  });
});
