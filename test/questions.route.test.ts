import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/guardrail-runner", () => ({ guardText: vi.fn() }));
import { POST, PATCH, DELETE } from "@/app/api/questions/route";
import { auth } from "@/lib/auth";
import { guardText } from "@/lib/guardrail-runner";
import { prisma } from "@/lib/prisma";
import {
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
  resetDb,
} from "./db";

const request = (body: unknown) =>
  new Request("http://localhost/api/questions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(async () => {
  await resetDb();
  vi.mocked(auth).mockReset();
  vi.mocked(guardText).mockReset();
  vi.mocked(guardText).mockResolvedValue({ blocked: false } as never);
});
afterAll(() => prisma.$disconnect());

async function fixture() {
  const { user, teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  vi.mocked(auth).mockResolvedValue({
    user: { id: user.id, role: "TEACHER" },
  } as never);
  return {
    cls,
    ...(await createPublishedQuiz({ classId: cls.id, teacherId: teacher.id })),
  };
}

describe("question authoring", () => {
  it.each([null, [], { text: 12 }, { text: "Question", options: "wrong" }])(
    "rejects malformed create input: %j",
    async (body) => {
      await fixture();
      expect((await POST(request(body))).status).toBe(400);
    },
  );

  it("returns a client error for invalid JSON and oversized bodies", async () => {
    await fixture();
    expect(
      (
        await DELETE(
          new Request("http://localhost/api/questions", {
            method: "DELETE",
            body: "{",
          }) as never,
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(request({ text: "a".repeat(1024 * 1024) }))).status,
    ).toBe(413);
  });

  it("preserves option ids, image crops, and students' selected-option references", async () => {
    const { cls, quiz, question } = await fixture();
    const selected = question.options.find((option) => option.isCorrect)!;
    await prisma.option.update({
      where: { id: selected.id },
      data: { imageStorageKey: "crop.png", imageBucket: "bucket" },
    });
    const { student } = await createStudent();
    const attempt = await prisma.quizAttempt.create({
      data: {
        classId: cls.id,
        quizId: quiz.id,
        studentId: student.id,
        score: 100,
        answers: {
          create: {
            questionId: question.id,
            selectedOptionId: selected.id,
            isCorrect: true,
          },
        },
      },
      include: { answers: true },
    });
    const response = await PATCH(
      request({
        id: question.id,
        text: "Updated prompt",
        options: question.options.map(({ id, text, isCorrect }) => ({
          id,
          text,
          isCorrect,
        })),
      }),
    );
    expect(response.status).toBe(200);
    const answer = await prisma.quizAnswer.findUniqueOrThrow({
      where: { id: attempt.answers[0].id },
    });
    expect(answer.selectedOptionId).toBe(selected.id);
    const crop = await prisma.option.findUniqueOrThrow({
      where: { id: selected.id },
    });
    expect(crop.imageStorageKey).toBe("crop.png");
  });

  it("validates the stored mode when a PATCH omits answerMode", async () => {
    const { question } = await fixture();
    const res = await PATCH(
      request({
        id: question.id,
        text: "Must not persist",
        options: question.options.map((option) => ({
          ...option,
          isCorrect: true,
        })),
      }),
    );
    expect(res.status).toBe(400);
    expect(
      (await prisma.question.findUniqueOrThrow({ where: { id: question.id } }))
        .text,
    ).toBe(question.text);
    expect(
      await prisma.option.count({ where: { questionId: question.id } }),
    ).toBe(3);
  });

  it("does not switch numeric questions to a choice mode without valid options", async () => {
    const { question } = await fixture();
    expect(
      (
        await PATCH(
          request({ id: question.id, answerMode: "NUMERIC", answerNumeric: 4 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await PATCH(request({ id: question.id, answerMode: "SINGLE_SELECT" })))
        .status,
    ).toBe(400);
    expect(
      (await prisma.question.findUniqueOrThrow({ where: { id: question.id } }))
        .answerMode,
    ).toBe("NUMERIC");
  });

  it("accepts client-generated ids for new choices without reusing another question's option", async () => {
    const { question } = await fixture();
    const response = await PATCH(
      request({
        id: question.id,
        options: [
          { id: "new-client-id", text: "New", isCorrect: false },
          { ...question.options[1] },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.options).toHaveLength(2);
    expect(
      body.options.find((option: { text: string }) => option.text === "New").id,
    ).not.toBe("new-client-id");
  });

  it("runs the authoring guardrail on edits before writing", async () => {
    const { question } = await fixture();
    vi.mocked(guardText).mockResolvedValue({
      blocked: true,
      message: "Blocked",
      eventId: "event",
    } as never);
    expect(
      (await PATCH(request({ id: question.id, text: "Rejected edit" }))).status,
    ).toBe(422);
    expect(
      (await prisma.question.findUniqueOrThrow({ where: { id: question.id } }))
        .text,
    ).toBe(question.text);
  });

  it("rejects editing another teacher's question", async () => {
    const { question } = await fixture();
    const { user } = await createTeacher();
    vi.mocked(auth).mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);
    expect(
      (await PATCH(request({ id: question.id, text: "Unauthorized" }))).status,
    ).toBe(404);
  });
});
