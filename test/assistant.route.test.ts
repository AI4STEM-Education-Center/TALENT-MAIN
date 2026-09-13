import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as GET_CONFIG } from "@/app/api/assistant/config/route";
import { POST as POST_CHAT } from "@/app/api/assistant/chat/route";
import {
  GET as GET_ADMIN,
  PUT as PUT_ADMIN,
} from "@/app/api/admin/assistants/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAssistantSettings, saveAssistantSettings } from "@/lib/assistant/config";
import { resolveAssistantSession } from "@/lib/assistant/session";
import { listSkills, resolveSkills } from "@/lib/assistant/skills";
import type { AssistantTool, AssistantToolContext } from "@/lib/assistant/types";
import { resetDb, createTeacher, createStudent, createAdmin, createClass } from "./db";

const mockAuth = vi.mocked(auth);

const asStudent = (userId: string) =>
  mockAuth.mockResolvedValue({ user: { id: userId, role: "STUDENT" } } as never);
const asTeacher = (userId: string) =>
  mockAuth.mockResolvedValue({ user: { id: userId, role: "TEACHER" } } as never);
const asAdmin = (userId: string) =>
  mockAuth.mockResolvedValue({ user: { id: userId, role: "ADMIN" } } as never);

const jsonRequest = (body: unknown, url = "http://localhost/api/assistant/chat") =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Look a tool up by name across every skill registered for an audience. */
function tool(audience: "student" | "teacher", name: string): AssistantTool {
  const found = listSkills(audience)
    .flatMap((skill) => skill.tools)
    .find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

/** Run a tool the way the agent would: validate args, then call the handler. */
async function callTool(
  audience: "student" | "teacher",
  name: string,
  args: unknown,
  ctx: AssistantToolContext
) {
  const target = tool(audience, name);
  return target.handler(target.input.parse(args) as never, ctx) as Promise<
    Record<string, unknown>
  >;
}

const studentCtx = (userId: string, studentId: string): AssistantToolContext => ({
  userId,
  audience: "student",
  studentId,
  teacherId: null,
});

const teacherCtx = (userId: string, teacherId: string): AssistantToolContext => ({
  userId,
  audience: "teacher",
  studentId: null,
  teacherId,
});

let resultSeq = 0;

/** An archived exam result. ExamResult is relation-free, so ids can be arbitrary. */
async function createResult(opts: {
  studentId: string;
  classId?: string;
  quizId?: string;
  className?: string;
  topicName?: string;
  quizName?: string;
  score?: number;
  completedAt?: Date;
  correct?: boolean;
}) {
  resultSeq += 1;
  const correct = opts.correct ?? true;
  return prisma.examResult.create({
    data: {
      quizAttemptId: `attempt-${resultSeq}`,
      studentId: opts.studentId,
      classId: opts.classId ?? "class-x",
      quizId: opts.quizId ?? "quiz-x",
      className: opts.className ?? "Physics 101",
      topicName: opts.topicName ?? "Kinematics",
      quizName: opts.quizName ?? "Motion Basics",
      score: opts.score ?? 80,
      correctCount: correct ? 1 : 0,
      totalCount: 1,
      completedAt: opts.completedAt ?? new Date("2026-03-01T00:00:00Z"),
      reviewSnapshot: JSON.stringify({
        questions: [
          {
            text: "What is 2 + 2?",
            isCorrect: correct,
            options: [
              { text: "3", isCorrect: false, selected: !correct },
              { text: "4", isCorrect: true, selected: correct },
            ],
          },
        ],
      }),
    },
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── Session resolution ──────────────────────────────────────────────────────

describe("resolveAssistantSession", () => {
  it("returns null for a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect(await resolveAssistantSession()).toBeNull();
  });

  it("returns null for an admin — admins configure assistants, they don't use one", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    expect(await resolveAssistantSession()).toBeNull();
  });

  it("scopes a student to their own studentId and nothing else", async () => {
    const { user, student } = await createStudent();
    asStudent(user.id);
    const session = await resolveAssistantSession();
    expect(session?.ctx).toEqual({
      userId: user.id,
      audience: "student",
      studentId: student.id,
      teacherId: null,
    });
  });

  it("scopes a teacher to their own teacherId and nothing else", async () => {
    const { user, teacher } = await createTeacher();
    asTeacher(user.id);
    const session = await resolveAssistantSession();
    expect(session?.ctx).toEqual({
      userId: user.id,
      audience: "teacher",
      studentId: null,
      teacherId: teacher.id,
    });
  });
});

// ─── GET /api/assistant/config ───────────────────────────────────────────────

describe("GET /api/assistant/config", () => {
  it("reports unavailable — not an error — when signed out", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await GET_CONFIG();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("reports unavailable while the assistant is disabled", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    expect(await (await GET_CONFIG()).json()).toEqual({ available: false });
  });

  it("reports unavailable to an admin", async () => {
    await saveAssistantSettings("student", { enabled: true });
    const admin = await createAdmin();
    asAdmin(admin.id);
    expect(await (await GET_CONFIG()).json()).toEqual({ available: false });
  });

  it("returns the audience, greeting and input limits once enabled", async () => {
    await saveAssistantSettings("student", {
      enabled: true,
      maxAttachments: 3,
      attachmentKinds: ["image"],
    });
    const { user } = await createStudent();
    asStudent(user.id);
    const body = await (await GET_CONFIG()).json();
    expect(body.available).toBe(true);
    expect(body.audience).toBe("student");
    expect(body.maxAttachments).toBe(3);
    expect(body.attachmentKinds).toEqual([
      expect.objectContaining({ kind: "image", accept: expect.stringContaining("image/png") }),
    ]);
    expect(body.toolCount).toBeGreaterThan(0);
  });

  it("gives a teacher the teacher assistant, not the student one", async () => {
    await saveAssistantSettings("teacher", { enabled: true });
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await (await GET_CONFIG()).json()).audience).toBe("teacher");
  });
});

// ─── POST /api/assistant/chat ────────────────────────────────────────────────

describe("POST /api/assistant/chat", () => {
  it("401s a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST_CHAT(jsonRequest({ message: "hi" }));
    expect(res.status).toBe(401);
  });

  it("401s an admin", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    expect((await POST_CHAT(jsonRequest({ message: "hi" }))).status).toBe(401);
  });

  it("503s while the assistant is disabled", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    const res = await POST_CHAT(jsonRequest({ message: "hi" }));
    expect(res.status).toBe(503);
  });

  it("400s an empty message", async () => {
    await saveAssistantSettings("student", { enabled: true });
    const { user } = await createStudent();
    asStudent(user.id);
    expect((await POST_CHAT(jsonRequest({ message: "" }))).status).toBe(400);
  });

  it("accepts the null conversationId the panel sends on a first turn", async () => {
    // The widget holds "no conversation yet" as null and serialises it, so a
    // schema that only allowed the key to be absent 400'd every opening message.
    await saveAssistantSettings("student", { enabled: true });
    const { user } = await createStudent();
    asStudent(user.id);
    const res = await POST_CHAT(jsonRequest({ message: "hi", conversationId: null }));
    expect(res.status).toBe(200);
  });

  it("400s a non-JSON body", async () => {
    await saveAssistantSettings("student", { enabled: true });
    const { user } = await createStudent();
    asStudent(user.id);
    const res = await POST_CHAT(
      new Request("http://localhost/api/assistant/chat", { method: "POST", body: "{oops" })
    );
    expect(res.status).toBe(400);
  });

  it("413s a body past the attachment budget", async () => {
    await saveAssistantSettings("student", {
      enabled: true,
      maxAttachments: 1,
      maxAttachmentBytes: 64 * 1024,
    });
    const { user } = await createStudent();
    asStudent(user.id);
    // 512 KB of payload against a ~256 KB overhead + ~85 KB attachment budget.
    const res = await POST_CHAT(
      jsonRequest({
        message: "hi",
        attachments: [
          { name: "big.png", mimeType: "image/png", dataBase64: "A".repeat(512 * 1024) },
        ],
      })
    );
    expect(res.status).toBe(413);
  });

  it("streams NDJSON, reporting the unassigned model rather than failing the request", async () => {
    await saveAssistantSettings("student", { enabled: true });
    const { user } = await createStudent();
    asStudent(user.id);
    const res = await POST_CHAT(jsonRequest({ message: "hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    const text = await res.text();
    const events = text.trim().split("\n").map((line) => JSON.parse(line));
    // The transcript is opened before the model is resolved, so even a turn that
    // cannot be answered names the conversation it would have been written to.
    expect(events).toEqual([
      { type: "conversation", id: expect.any(String) },
      { type: "error", message: expect.stringContaining("no AI model assigned") },
    ]);
  });
});

// ─── Student tools ───────────────────────────────────────────────────────────

describe("student quiz-result tools", () => {
  it("returns every result newest-first when called with no filters", async () => {
    const { user, student } = await createStudent();
    await createResult({
      studentId: student.id,
      quizName: "Older",
      completedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await createResult({
      studentId: student.id,
      quizName: "Newer",
      completedAt: new Date("2026-02-01T00:00:00Z"),
    });

    const out = await callTool("student", "search_quiz_results", {}, studentCtx(user.id, student.id));
    expect(out.totalMatches).toBe(2);
    expect((out.results as Array<{ quizName: string }>).map((r) => r.quizName)).toEqual([
      "Newer",
      "Older",
    ]);
  });

  it("never returns another student's results", async () => {
    const mine = await createStudent();
    const theirs = await createStudent();
    await createResult({ studentId: theirs.student.id, quizName: "Not Mine" });

    const out = await callTool(
      "student",
      "search_quiz_results",
      {},
      studentCtx(mine.user.id, mine.student.id)
    );
    expect(out.totalMatches).toBe(0);
  });

  it("matches quiz name and topic case-insensitively", async () => {
    const { user, student } = await createStudent();
    await createResult({ studentId: student.id, quizName: "Newton's Laws", topicName: "Forces" });
    await createResult({ studentId: student.id, quizName: "Optics Basics", topicName: "Light" });

    const byQuiz = await callTool(
      "student",
      "search_quiz_results",
      { quizName: "newton" },
      studentCtx(user.id, student.id)
    );
    expect(byQuiz.totalMatches).toBe(1);

    const byTopic = await callTool(
      "student",
      "search_quiz_results",
      { topic: "LIGHT" },
      studentCtx(user.id, student.id)
    );
    expect((byTopic.results as Array<{ quizName: string }>)[0].quizName).toBe("Optics Basics");
  });

  it("combines filters with AND", async () => {
    const { user, student } = await createStudent();
    await createResult({ studentId: student.id, quizName: "Quiz A", topicName: "Forces", score: 90 });
    await createResult({ studentId: student.id, quizName: "Quiz A", topicName: "Optics", score: 40 });

    const out = await callTool(
      "student",
      "search_quiz_results",
      { quizName: "Quiz A", minScore: 60 },
      studentCtx(user.id, student.id)
    );
    expect(out.totalMatches).toBe(1);
    expect((out.results as Array<{ topic: string }>)[0].topic).toBe("Forces");
  });

  it("filters on a date range", async () => {
    const { user, student } = await createStudent();
    await createResult({
      studentId: student.id,
      quizName: "January",
      completedAt: new Date("2026-01-15T00:00:00Z"),
    });
    await createResult({
      studentId: student.id,
      quizName: "March",
      completedAt: new Date("2026-03-15T00:00:00Z"),
    });

    const out = await callTool(
      "student",
      "search_quiz_results",
      { completedAfter: "2026-02-01" },
      studentCtx(user.id, student.id)
    );
    expect((out.results as Array<{ quizName: string }>).map((r) => r.quizName)).toEqual(["March"]);
  });

  it("honours the limit while still reporting the true match count", async () => {
    const { user, student } = await createStudent();
    for (let i = 0; i < 4; i += 1) await createResult({ studentId: student.id });

    const out = await callTool(
      "student",
      "search_quiz_results",
      { limit: 2 },
      studentCtx(user.id, student.id)
    );
    expect(out.totalMatches).toBe(4);
    expect(out.returned).toBe(2);
    expect(out.results).toHaveLength(2);
  });

  it("returns the per-question breakdown for a result whose quiz is gone", async () => {
    const { user, student } = await createStudent();
    // No ClassQuiz row exists for this result's class/quiz, so nothing further
    // can ever be submitted and the attempt counts as final.
    const result = await createResult({ studentId: student.id, correct: false, score: 0 });

    const out = await callTool(
      "student",
      "get_quiz_result_detail",
      { resultId: result.quizAttemptId },
      studentCtx(user.id, student.id)
    );
    expect(out.found).toBe(true);
    expect(out.attemptState).toBe("final");
    expect(out.questions).toEqual([
      expect.objectContaining({ number: 1, isCorrect: false, yourAnswer: ["3"], correctAnswer: ["4"] }),
    ]);
  });

  it("reports another student's resultId as not found", async () => {
    const mine = await createStudent();
    const theirs = await createStudent();
    const result = await createResult({ studentId: theirs.student.id });

    const out = await callTool(
      "student",
      "get_quiz_result_detail",
      { resultId: result.quizAttemptId },
      studentCtx(mine.user.id, mine.student.id)
    );
    expect(out.found).toBe(false);
    expect(out).not.toHaveProperty("questions");
  });

  it("reports a fabricated resultId as not found", async () => {
    const { user, student } = await createStudent();
    const out = await callTool(
      "student",
      "get_quiz_result_detail",
      { resultId: "made-up" },
      studentCtx(user.id, student.id)
    );
    expect(out.found).toBe(false);
  });

  it("aggregates by topic, weakest group first", async () => {
    const { user, student } = await createStudent();
    await createResult({ studentId: student.id, topicName: "Forces", score: 90 });
    await createResult({ studentId: student.id, topicName: "Forces", score: 70 });
    await createResult({ studentId: student.id, topicName: "Optics", score: 30 });

    const out = await callTool(
      "student",
      "summarize_performance",
      { groupBy: "topic" },
      studentCtx(user.id, student.id)
    );
    const groups = out.groups as Array<{ name: string; meanScore: number; attempts: number }>;
    expect(groups.map((g) => g.name)).toEqual(["Optics", "Forces"]);
    expect(groups[1]).toMatchObject({ attempts: 2, meanScore: 80 });
  });

  it("excludes other students from the aggregate", async () => {
    const mine = await createStudent();
    const theirs = await createStudent();
    await createResult({ studentId: mine.student.id, topicName: "Forces", score: 100 });
    await createResult({ studentId: theirs.student.id, topicName: "Forces", score: 0 });

    const out = await callTool(
      "student",
      "summarize_performance",
      { groupBy: "topic" },
      studentCtx(mine.user.id, mine.student.id)
    );
    expect((out.groups as Array<{ meanScore: number }>)[0].meanScore).toBe(100);
  });

  it("refuses to run without a resolved student", async () => {
    await expect(
      callTool("student", "search_quiz_results", {}, {
        userId: "u",
        audience: "student",
        studentId: null,
        teacherId: null,
      })
    ).rejects.toThrow(/only available to students/);
  });
});

// ─── Answer-key gating ───────────────────────────────────────────────────────
// get_quiz_result_detail is the only tool that can reach an answer key, and it
// may only do so once the attempt is beyond retaking. Each case below is one way
// "beyond retaking" can be true or false; the withholding cases matter most,
// because a leak there hands a student the answers to a live quiz.

describe("get_quiz_result_detail — answer-key gating", () => {
  /**
   * A real class + quiz + ClassQuiz row, plus an archived result for the student,
   * so the gate has actual rows to read (unlike createResult's synthetic ids).
   */
  async function gatedResult(opts: {
    availableUntil?: Date | null;
    availableFrom?: Date | null;
    maxAttempts?: number | null;
    published?: boolean;
    completedAttempts?: number;
    inProgressAttempts?: number;
    offered?: boolean;
  }) {
    const teacher = await createTeacher();
    const { user, student } = await createStudent();
    const klass = await createClass(teacher.teacher.id);
    const quiz = await prisma.quiz.create({
      data: { name: "Live Quiz", teacherId: teacher.teacher.id },
    });
    if (opts.offered !== false) {
      await prisma.classQuiz.create({
        data: {
          classId: klass.id,
          quizId: quiz.id,
          published: opts.published ?? true,
          availableFrom: opts.availableFrom ?? null,
          availableUntil: opts.availableUntil ?? null,
          maxAttempts: opts.maxAttempts ?? null,
        },
      });
    }
    for (let i = 0; i < (opts.completedAttempts ?? 1); i += 1) {
      await prisma.quizAttempt.create({
        data: {
          studentId: student.id,
          classId: klass.id,
          quizId: quiz.id,
          completedAt: new Date("2026-03-01T00:00:00Z"),
        },
      });
    }
    for (let i = 0; i < (opts.inProgressAttempts ?? 0); i += 1) {
      await prisma.quizAttempt.create({
        data: { studentId: student.id, classId: klass.id, quizId: quiz.id },
      });
    }
    const result = await createResult({
      studentId: student.id,
      classId: klass.id,
      quizId: quiz.id,
      correct: false,
      score: 0,
    });
    return {
      detail: () =>
        callTool(
          "student",
          "get_quiz_result_detail",
          { resultId: result.quizAttemptId },
          studentCtx(user.id, student.id)
        ),
    };
  }

  const past = new Date("2020-01-01T00:00:00Z");
  const future = new Date("2099-01-01T00:00:00Z");

  it("withholds the key while the quiz is open with attempts left", async () => {
    const { detail } = await gatedResult({ maxAttempts: 3, completedAttempts: 1 });
    const out = await detail();
    expect(out.attemptState).toBe("retake_possible");
    expect(out.answerKeyWithheld).toBe(true);
    const questions = out.questions as Array<Record<string, unknown>>;
    expect(questions[0]).toEqual({ number: 1, text: "What is 2 + 2?", yourAnswer: ["3"] });
    // isCorrect leaks the key on a short option list, so it goes too.
    expect(questions[0]).not.toHaveProperty("isCorrect");
    expect(questions[0]).not.toHaveProperty("correctAnswer");
  });

  it("withholds the key on an uncapped, never-closing quiz", async () => {
    const { detail } = await gatedResult({});
    expect((await detail()).answerKeyWithheld).toBe(true);
  });

  it("reveals the key once every attempt is used up", async () => {
    const { detail } = await gatedResult({ maxAttempts: 2, completedAttempts: 2 });
    const out = await detail();
    expect(out.attemptState).toBe("final");
    expect(out).not.toHaveProperty("answerKeyWithheld");
    expect((out.questions as Array<Record<string, unknown>>)[0]).toMatchObject({
      isCorrect: false,
      correctAnswer: ["4"],
    });
  });

  it("reveals the key after the quiz closes", async () => {
    const { detail } = await gatedResult({ availableUntil: past });
    expect((await detail()).attemptState).toBe("final");
  });

  it("reveals the key when the quiz is no longer offered to the class", async () => {
    const { detail } = await gatedResult({ offered: false });
    expect((await detail()).attemptState).toBe("final");
  });

  it("withholds the key while an attempt is still in progress, cap reached or not", async () => {
    const { detail } = await gatedResult({
      maxAttempts: 1,
      completedAttempts: 1,
      inProgressAttempts: 1,
    });
    expect((await detail()).answerKeyWithheld).toBe(true);
  });

  it("withholds the key past the cap when the window has not opened yet", async () => {
    // A future window means the quiz is coming back; treating it as final would
    // publish an answer key ahead of the reopening.
    const { detail } = await gatedResult({
      availableFrom: future,
      maxAttempts: 1,
      completedAttempts: 1,
    });
    expect((await detail()).answerKeyWithheld).toBe(true);
  });

  it("withholds the key for an unpublished quiz — a teacher can republish it", async () => {
    const { detail } = await gatedResult({ published: false, maxAttempts: 1, completedAttempts: 1 });
    expect((await detail()).answerKeyWithheld).toBe(true);
  });

  it("still reports the score and summary while withholding the key", async () => {
    const { detail } = await gatedResult({});
    const out = await detail();
    // Aggregates say how many were right, never which — that is what their own
    // results page already shows them.
    expect(out).toMatchObject({ found: true, score: 0, correctCount: 0, totalCount: 1 });
  });
});

// ─── Teacher tools ───────────────────────────────────────────────────────────

describe("teacher class-insight tools", () => {
  it("lists only the teacher's own classes", async () => {
    const mine = await createTeacher();
    const theirs = await createTeacher();
    await createClass(mine.teacher.id, "Mine");
    await createClass(theirs.teacher.id, "Theirs");

    const out = await callTool(
      "teacher",
      "list_classes",
      {},
      teacherCtx(mine.user.id, mine.teacher.id)
    );
    expect((out.classes as Array<{ name: string }>).map((c) => c.name)).toEqual(["Mine"]);
  });

  it("reports enrollment and quiz counts", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const { student } = await createStudent();
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });

    const out = await callTool("teacher", "list_classes", {}, teacherCtx(user.id, teacher.id));
    expect((out.classes as Array<Record<string, number>>)[0]).toMatchObject({
      enrolledStudents: 1,
      assignedQuizzes: 0,
    });
  });

  it("returns an overview for an owned class without student emails", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const { student } = await createStudent();
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });

    const out = await callTool(
      "teacher",
      "get_class_overview",
      { classId: cls.id },
      teacherCtx(user.id, teacher.id)
    );
    expect(out.found).toBe(true);
    expect(out.className).toBe("Physics");
    const students = out.students as Array<Record<string, unknown>>;
    expect(students).toHaveLength(1);
    expect(students[0]).not.toHaveProperty("email");
  });

  it("reports another teacher's class as not found", async () => {
    const owner = await createTeacher();
    const intruder = await createTeacher();
    const cls = await createClass(owner.teacher.id, "Theirs");

    const out = await callTool(
      "teacher",
      "get_class_overview",
      { classId: cls.id },
      teacherCtx(intruder.user.id, intruder.teacher.id)
    );
    expect(out.found).toBe(false);
    expect(out).not.toHaveProperty("students");
  });

  it("reports a quiz breakdown for an owned class", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const quiz = await prisma.quiz.create({ data: { name: "Motion", teacherId: teacher.id } });
    await prisma.classQuiz.create({ data: { classId: cls.id, quizId: quiz.id, published: true } });

    const out = await callTool(
      "teacher",
      "get_quiz_breakdown",
      { classId: cls.id, quizId: quiz.id },
      teacherCtx(user.id, teacher.id)
    );
    expect(out).toMatchObject({ found: true, quizName: "Motion", attemptsTotal: 0 });
  });

  it("refuses a quiz breakdown for a class the teacher does not own", async () => {
    const owner = await createTeacher();
    const intruder = await createTeacher();
    const cls = await createClass(owner.teacher.id, "Theirs");
    const quiz = await prisma.quiz.create({ data: { name: "Motion", teacherId: owner.teacher.id } });
    await prisma.classQuiz.create({ data: { classId: cls.id, quizId: quiz.id, published: true } });

    const out = await callTool(
      "teacher",
      "get_quiz_breakdown",
      { classId: cls.id, quizId: quiz.id },
      teacherCtx(intruder.user.id, intruder.teacher.id)
    );
    expect(out.found).toBe(false);
  });

  it("returns a student breakdown only for an enrolled student", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const enrolled = await createStudent();
    const outsider = await createStudent();
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: enrolled.student.id },
    });

    const ok = await callTool(
      "teacher",
      "get_student_breakdown",
      { classId: cls.id, studentId: enrolled.student.id },
      teacherCtx(user.id, teacher.id)
    );
    expect(ok.found).toBe(true);

    const denied = await callTool(
      "teacher",
      "get_student_breakdown",
      { classId: cls.id, studentId: outsider.student.id },
      teacherCtx(user.id, teacher.id)
    );
    expect(denied).toMatchObject({ found: false, message: expect.stringContaining("not enrolled") });
  });

  it("flags a student with no completed quizzes and, separately, one below the threshold", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const idle = await createStudent();
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: idle.student.id } });

    const withInactive = await callTool(
      "teacher",
      "find_struggling_students",
      { classId: cls.id },
      teacherCtx(user.id, teacher.id)
    );
    const classes = withInactive.classes as Array<{
      flaggedStudents: Array<{ reason: string }>;
    }>;
    expect(classes[0].flaggedStudents).toEqual([
      expect.objectContaining({ reason: "no completed quizzes" }),
    ]);

    const withoutInactive = await callTool(
      "teacher",
      "find_struggling_students",
      { classId: cls.id, includeInactive: false },
      teacherCtx(user.id, teacher.id)
    );
    expect(
      (withoutInactive.classes as Array<{ flaggedStudents: unknown[] }>)[0].flaggedStudents
    ).toEqual([]);
  });

  it("never scans another teacher's classes", async () => {
    const mine = await createTeacher();
    const theirs = await createTeacher();
    await createClass(mine.teacher.id, "Mine");
    const foreign = await createClass(theirs.teacher.id, "Theirs");

    const all = await callTool(
      "teacher",
      "find_struggling_students",
      {},
      teacherCtx(mine.user.id, mine.teacher.id)
    );
    expect((all.classes as Array<{ className: string }>).map((c) => c.className)).toEqual(["Mine"]);

    const targeted = await callTool(
      "teacher",
      "find_struggling_students",
      { classId: foreign.id },
      teacherCtx(mine.user.id, mine.teacher.id)
    );
    expect(targeted.found).toBe(false);
  });

  it("refuses to run without a resolved teacher", async () => {
    await expect(
      callTool("teacher", "list_classes", {}, {
        userId: "u",
        audience: "teacher",
        studentId: null,
        teacherId: null,
      })
    ).rejects.toThrow(/only available to teachers/);
  });
});

// ─── Settings persistence + admin API ────────────────────────────────────────

describe("assistant settings", () => {
  it("defaults to disabled with every registered skill for the audience", async () => {
    const settings = await getAssistantSettings("student");
    expect(settings.enabled).toBe(false);
    expect(settings.enabledSkills).toEqual(listSkills("student").map((s) => s.id));
  });

  it("round-trips a saved patch", async () => {
    await saveAssistantSettings("teacher", {
      enabled: true,
      extraInstructions: "Be terse.",
      attachmentKinds: ["image", "csv"],
      maxAttachments: 2,
    });
    const settings = await getAssistantSettings("teacher");
    expect(settings).toMatchObject({
      enabled: true,
      extraInstructions: "Be terse.",
      attachmentKinds: ["image", "csv"],
      maxAttachments: 2,
    });
  });

  it("keeps the two audiences independent", async () => {
    await saveAssistantSettings("student", { enabled: true });
    expect((await getAssistantSettings("teacher")).enabled).toBe(false);
  });

  it("clamps out-of-range numbers instead of rejecting the save", async () => {
    const settings = await saveAssistantSettings("student", {
      maxToolCalls: 9999,
      turnsPerHour: 0,
    });
    expect(settings.maxToolCalls).toBe(12);
    expect(settings.turnsPerHour).toBe(1);
  });

  it("drops an unknown skill id and a skill from the other audience", async () => {
    const teacherSkillId = listSkills("teacher")[0].id;
    const settings = await saveAssistantSettings("student", {
      enabledSkills: ["ghost-skill", teacherSkillId, ...listSkills("student").map((s) => s.id)],
    });
    expect(settings.enabledSkills).toEqual(listSkills("student").map((s) => s.id));
  });

  it("leaves fields the patch omitted untouched", async () => {
    await saveAssistantSettings("student", {
      attachmentKinds: ["image", "csv"],
      maxAttachments: 3,
    });
    // A patch that only flips `enabled` must not blank the attachment config.
    const settings = await saveAssistantSettings("student", { enabled: true });
    expect(settings).toMatchObject({
      enabled: true,
      attachmentKinds: ["image", "csv"],
      maxAttachments: 3,
    });
  });

  it("drops an unregistered attachment kind", async () => {
    const settings = await saveAssistantSettings("student", {
      attachmentKinds: ["image", "exe"],
    });
    expect(settings.attachmentKinds).toEqual(["image"]);
  });

  it("loads no tools for a stale skill id left in the database", async () => {
    await prisma.assistantConfig.create({
      data: {
        id: "student",
        audience: "student",
        enabled: true,
        enabledSkills: JSON.stringify(["removed-skill"]),
      },
    });
    const settings = await getAssistantSettings("student");
    expect(resolveSkills("student", settings.enabledSkills).tools.size).toBe(0);
  });

  it("round-trips disabled tool names and drops unknown ones", async () => {
    const settings = await saveAssistantSettings("student", {
      disabledTools: ["get_quiz_result_detail", "no_such_tool"],
    });
    expect(settings.disabledTools).toEqual(["get_quiz_result_detail"]);
    expect(
      resolveSkills("student", settings.enabledSkills, settings.disabledTools).tools.has(
        "get_quiz_result_detail"
      )
    ).toBe(false);
  });

  it("drops a tool name that belongs to the other audience", async () => {
    const teacherTool = listSkills("teacher")[0].tools[0].name;
    const settings = await saveAssistantSettings("student", { disabledTools: [teacherTool] });
    expect(settings.disabledTools).toEqual([]);
  });

  it("defaults attachment retention to 30 days and clamps it on save", async () => {
    expect((await getAssistantSettings("student")).attachmentRetentionDays).toBe(30);
    expect(
      (await saveAssistantSettings("student", { attachmentRetentionDays: 9999 }))
        .attachmentRetentionDays
    ).toBe(365);
    expect(
      (await saveAssistantSettings("student", { attachmentRetentionDays: 0 }))
        .attachmentRetentionDays
    ).toBe(1);
  });

  it("falls back to defaults when the JSON columns are corrupt", async () => {
    await prisma.assistantConfig.create({
      data: {
        id: "teacher",
        audience: "teacher",
        enabledSkills: "not json",
        attachmentKinds: "{",
      },
    });
    const settings = await getAssistantSettings("teacher");
    expect(settings.enabledSkills).toEqual([]);
    expect(settings.attachmentKinds).toEqual([]);
  });
});

describe("admin assistants API", () => {
  it("403s a non-admin on GET and PUT", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await GET_ADMIN()).status).toBe(403);
    expect(
      (
        await PUT_ADMIN(
          jsonRequest({ audience: "student", settings: { enabled: true } }, "http://localhost/api/admin/assistants")
        )
      ).status
    ).toBe(403);
  });

  it("returns both assistants plus the code-derived catalogs", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    const body = await (await GET_ADMIN()).json();
    expect(body.assistants.map((a: { audience: string }) => a.audience)).toEqual([
      "student",
      "teacher",
    ]);
    expect(body.assistants[0].useCase).toBe("student_assistant");
    expect(body.assistants[0].availableSkills.length).toBeGreaterThan(0);
    expect(body.attachmentKinds.length).toBeGreaterThan(0);
    expect(body.bounds.maxToolCalls).toEqual({ min: 1, max: 12 });
    expect(body.bounds.attachmentRetentionDays).toEqual({ min: 1, max: 365 });
    // Per-tool entries are what the admin form renders its tool checkboxes from.
    expect(body.assistants[0].availableSkills[0].tools[0]).toMatchObject({
      name: expect.any(String),
      label: expect.any(String),
    });
  });

  it("saves per-tool toggles through the admin route", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    const res = await PUT_ADMIN(
      jsonRequest(
        {
          audience: "student",
          settings: { disabledTools: ["summarize_performance", "bogus"] },
        },
        "http://localhost/api/admin/assistants"
      )
    );
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.disabledTools).toEqual(["summarize_performance"]);
  });

  it("saves a patch and echoes back the clamped values", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    const res = await PUT_ADMIN(
      jsonRequest(
        { audience: "student", settings: { enabled: true, maxToolCalls: 99 } },
        "http://localhost/api/admin/assistants"
      )
    );
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings).toMatchObject({ enabled: true, maxToolCalls: 12 });
    expect((await getAssistantSettings("student")).enabled).toBe(true);
  });

  it("400s an unknown audience", async () => {
    const admin = await createAdmin();
    asAdmin(admin.id);
    const res = await PUT_ADMIN(
      jsonRequest({ audience: "admin", settings: {} }, "http://localhost/api/admin/assistants")
    );
    expect(res.status).toBe(400);
  });
});
