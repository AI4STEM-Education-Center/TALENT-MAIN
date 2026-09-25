import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueQuizVariant: vi.fn() }));
import { auth } from "@/lib/auth";
import { enqueueQuizVariant } from "@/lib/queue";
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
  it("resumes identical content, ignores source edits, scores once, and leaves grades alone", async () => {
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
    expect(await (await submit(req(answers))).json()).toEqual({
      score: 100,
      incorrectQuestionIds: [],
    });
    expect((await submit(req(answers))).status).toBe(409);
    expect(await prisma.quizAttempt.count()).toBe(0);
    expect(await prisma.quizProgress.count()).toBe(0);
    expect(await prisma.examResult.count()).toBe(0);
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
