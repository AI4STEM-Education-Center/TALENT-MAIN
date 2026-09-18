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
