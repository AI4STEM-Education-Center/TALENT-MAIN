import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET } from "@/app/api/quizzes/[id]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startQuizPreview } from "@/components/quiz/quiz-session";
import { createClass, createPublishedQuiz, createTeacher, resetDb } from "./db";

beforeEach(async () => {
  await resetDb();
  vi.mocked(auth).mockReset();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => prisma.$disconnect());

async function setup() {
  const { user, teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { quiz, question } = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.id,
    published: false,
  });
  vi.mocked(auth).mockResolvedValue({
    user: { id: user.id, role: "TEACHER" },
  } as never);
  // Exercise the real authorized read route through the preview session.
  const fetchMock = vi.fn(async () =>
    GET({} as never, { params: Promise.resolve({ id: quiz.id }) }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { quiz, question, fetchMock, cls };
}

describe("teacher quiz preview", () => {
  it("grades a draft with student rules without writing any learning records", async () => {
    const { quiz, question, fetchMock, cls } = await setup();
    await prisma.classQuiz.update({
      where: { classId_quizId: { classId: cls.id, quizId: quiz.id } },
      data: { maxAttempts: 1, availableUntil: new Date("2020-01-01") },
    });
    const multi = await prisma.question.create({
      data: {
        quizId: quiz.id,
        text: "Select both",
        answerMode: "MULTI_SELECT",
        options: {
          create: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: true },
            { text: "C", isCorrect: false },
          ],
        },
      },
      include: { options: true },
    });
    const numeric = await prisma.question.create({
      data: {
        quizId: quiz.id,
        text: "Enter acceleration",
        answerMode: "NUMERIC",
        answerNumeric: 9.81,
        answerTolerance: 0.1,
        answerUnit: "m/s^2",
      },
    });

    const session = await startQuizPreview(quiz.id);
    expect(session.attemptId).toBeUndefined();
    expect(JSON.stringify(session.questions)).not.toMatch(
      /isCorrect|answerNumeric|answerTolerance/,
    );
    const answers = [
      {
        questionId: question.id,
        selectedOptionIds: [question.options.find((o) => o.isCorrect)!.id],
      },
      {
        questionId: multi.id,
        selectedOptionIds: multi.options
          .filter((o) => o.isCorrect)
          .map((o) => o.id),
      },
      { questionId: numeric.id, numericValue: 9.85 },
    ];
    expect(await session.submit(answers)).toEqual({
      score: 100,
      incorrectQuestionIds: [],
    });
    expect(
      await session.submit([
        answers[0],
        { questionId: multi.id, selectedOptionIds: [multi.options[0].id] },
        { questionId: numeric.id, numericValue: 10 },
      ]),
    ).toEqual({
      score: (1 / 3) * 100,
      incorrectQuestionIds: [multi.id, numeric.id],
    });
    expect(await session.submit([])).toEqual({
      score: 0,
      incorrectQuestionIds: [question.id, multi.id, numeric.id],
    });
    await startQuizPreview(quiz.id);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(`/api/quizzes/${quiz.id}`, {
      cache: "no-store",
    });
    expect(await prisma.quizAttempt.count()).toBe(0);
    expect(await prisma.quizAnswer.count()).toBe(0);
    expect(await prisma.quizProgress.count()).toBe(0);
    expect(await prisma.examResult.count()).toBe(0);
    expect(await prisma.student.count()).toBe(0);
    expect(
      await prisma.classQuiz.findUnique({
        where: { classId_quizId: { classId: cls.id, quizId: quiz.id } },
      }),
    ).toMatchObject({ published: false, maxAttempts: 1 });
  });

  it.each(["STUDENT", "anonymous", "other teacher"])(
    "rejects preview access by %s",
    async (actor) => {
      const { quiz } = await setup();
      const other = await createTeacher();
      vi.mocked(auth).mockResolvedValue(
        actor === "anonymous"
          ? (null as never)
          : ({
              user: {
                id: other.user.id,
                role: actor === "STUDENT" ? "STUDENT" : "TEACHER",
              },
            } as never),
      );
      await expect(startQuizPreview(quiz.id)).rejects.toThrow(
        actor === "other teacher" ? "Quiz not found" : "Unauthorized",
      );
      expect(await prisma.quizAttempt.count()).toBe(0);
    },
  );

  it("reports an empty quiz", async () => {
    const { quiz } = await setup();
    await prisma.question.deleteMany({ where: { quizId: quiz.id } });
    await expect(startQuizPreview(quiz.id)).rejects.toThrow(
      "No questions available",
    );
  });
});
