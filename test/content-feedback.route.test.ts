import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { POST } from "@/app/api/feedback/route";
import { GET as mineGet } from "@/app/api/feedback/mine/route";
import { GET as summaryGet } from "@/app/api/feedback/summary/route";
import { GET as exportGet } from "@/app/api/feedback/export/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";
import {
  resetDb,
  createStudent,
  createTeacher,
  createAdmin,
  createClass,
  createPublishedQuiz,
} from "./db";

const mockAuth = vi.mocked(auth);
const asUser = (id: string, role: string) =>
  mockAuth.mockResolvedValue({ user: { id, role } } as never);

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const getReq = (path: string) => new NextRequest(`http://localhost${path}`);

/**
 * A completed attempt whose stored results recommended one material ("Chapter
 * 3") and one simulation — the exact shape the student results page renders,
 * because that membership is what the POST route authorizes against.
 */
async function scenario() {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass(teacher.teacher.id, "Physics 101");
  const { quiz, question } = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.teacher.id,
  });
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.student.id },
  });
  const sim = await prisma.questionSimulation.create({
    data: {
      questionId: question.id,
      status: "READY",
      title: "Waves",
      topic: "Wave motion",
      learningGoal: "See how frequency changes the pattern",
      storageKey: "sims/waves.html",
      version: 1,
    },
  });
  const attempt = await prisma.quizAttempt.create({
    data: {
      studentId: student.student.id,
      classId: cls.id,
      quizId: quiz.id,
      completedAt: new Date(),
      score: 50,
    },
  });
  await prisma.examResult.create({
    data: {
      quizAttemptId: attempt.id,
      studentId: student.student.id,
      classId: cls.id,
      quizId: quiz.id,
      className: "Physics 101",
      topicName: "Waves",
      quizName: "Quiz 2",
      score: 50,
      correctCount: 1,
      totalCount: 2,
      completedAt: new Date(),
      reviewSnapshot: JSON.stringify({ questions: [] }),
      recommendationsStatus: "READY",
      recommendations: JSON.stringify({
        items: [
          {
            materialTitle: "Chapter 3",
            pageRange: { start: 4, end: 8 },
            reason: "Covers wave motion",
            pages: [],
          },
        ],
        truncated: false,
        simulations: [
          {
            simulationId: sim.id,
            title: "Waves",
            topic: "Wave motion",
            learningGoal: "See how frequency changes the pattern",
          },
        ],
      }),
    },
  });
  return { teacher, student, cls, quiz, sim, attempt };
}

const studentSimBody = (
  s: Awaited<ReturnType<typeof scenario>>,
  overrides: Record<string, unknown> = {},
) => ({
  subjectType: "SIMULATION",
  subjectId: s.sim.id,
  subjectLabel: "Waves",
  subjectDetail: "See how frequency changes the pattern",
  attemptId: s.attempt.id,
  rating: 4,
  comment: "Helped me see the phase shift.",
  ...overrides,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
});

describe("POST /api/feedback — student surface", () => {
  it("stores a rating with its class/quiz context and routes it to the teacher", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");

    const res = await POST(postReq(studentSimBody(s)));
    expect(res.status).toBe(201);

    const row = await prisma.contentFeedback.findFirstOrThrow();
    expect(row).toMatchObject({
      audience: "STUDENT",
      subjectType: "SIMULATION",
      subjectId: s.sim.id,
      rating: 4,
      authorRole: "STUDENT",
      routedTeacherId: s.teacher.teacher.id,
      classId: s.cls.id,
      className: "Physics 101",
      quizName: "Quiz 2",
    });
  });

  it("accepts a material identified only by its recommended title", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");

    const res = await POST(
      postReq({
        subjectType: "MATERIAL",
        subjectLabel: "chapter 3",
        subjectDetail: "pages 4–8",
        attemptId: s.attempt.id,
        rating: 2,
        comment: "Only the last page was relevant.",
      }),
    );
    expect(res.status).toBe(201);
    const row = await prisma.contentFeedback.findFirstOrThrow();
    expect(row.subjectType).toBe("MATERIAL");
    expect(row.subjectId).toBeNull();
  });

  it("replaces the author's earlier verdict instead of stacking a second", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");

    await POST(postReq(studentSimBody(s)));
    await POST(
      postReq(studentSimBody(s, { rating: 1, comment: "Changed my mind." })),
    );

    const rows = await prisma.contentFeedback.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(1);
    expect(rows[0].comment).toBe("Changed my mind.");
  });

  it("rejects a rating on content the attempt never recommended", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");

    const res = await POST(
      postReq(studentSimBody(s, { subjectId: "some-other-simulation" })),
    );
    expect(res.status).toBe(404);
    expect(await prisma.contentFeedback.count()).toBe(0);
  });

  it("rejects a rating on someone else's attempt", async () => {
    const s = await scenario();
    const other = await createStudent();
    asUser(other.user.id, "STUDENT");

    const res = await POST(postReq(studentSimBody(s)));
    expect(res.status).toBe(404);
    expect(await prisma.contentFeedback.count()).toBe(0);
  });

  it("requires an attempt, a rating on the scale, and an explanation", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");

    const noAttempt = await POST(
      postReq(studentSimBody(s, { attemptId: null })),
    );
    expect(noAttempt.status).toBe(400);

    for (const rating of [0, 6, 3.5]) {
      const res = await POST(postReq(studentSimBody(s, { rating })));
      expect(res.status).toBe(400);
    }

    const noComment = await POST(
      postReq(studentSimBody(s, { comment: "   " })),
    );
    expect(noComment.status).toBe(400);
    expect(await prisma.contentFeedback.count()).toBe(0);
  });

  it("refuses an anonymous caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST(postReq({}));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/feedback — teacher surface", () => {
  it("stores a teacher's verdict on a simulation on their own quiz", async () => {
    const s = await scenario();
    asUser(s.teacher.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "SIMULATION",
        subjectId: s.sim.id,
        subjectLabel: "Waves",
        rating: 5,
        comment: "Exactly the visual I wanted for this topic.",
      }),
    );
    expect(res.status).toBe(201);

    const row = await prisma.contentFeedback.findFirstOrThrow();
    expect(row).toMatchObject({
      audience: "TEACHER",
      authorRole: "TEACHER",
      routedTeacherId: s.teacher.teacher.id,
      attemptId: null,
      rating: 5,
    });
  });

  it("refuses a simulation on another teacher's quiz", async () => {
    const s = await scenario();
    const intruder = await createTeacher();
    asUser(intruder.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "SIMULATION",
        subjectId: s.sim.id,
        subjectLabel: "Waves",
        rating: 1,
        comment: "Not mine to rate.",
      }),
    );
    expect(res.status).toBe(404);
    expect(await prisma.contentFeedback.count()).toBe(0);
  });

  it("refuses a material with no attempt — there is no subject to point at", async () => {
    const s = await scenario();
    asUser(s.teacher.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "MATERIAL",
        subjectLabel: "Chapter 3",
        rating: 3,
        comment: "No route for this.",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/feedback — teacher rating a student's recommendations", () => {
  it("stores a verdict on a recommended material from the student's stats page", async () => {
    const s = await scenario();
    asUser(s.teacher.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "MATERIAL",
        subjectLabel: "Chapter 3",
        subjectDetail: "pages 4–8",
        attemptId: s.attempt.id,
        rating: 2,
        comment: "Wrong pages for where this student actually is.",
      }),
    );
    expect(res.status).toBe(201);

    const row = await prisma.contentFeedback.findFirstOrThrow();
    expect(row).toMatchObject({
      audience: "TEACHER",
      authorRole: "TEACHER",
      subjectType: "MATERIAL",
      routedTeacherId: s.teacher.teacher.id,
      attemptId: s.attempt.id,
      classId: s.cls.id,
      className: "Physics 101",
      quizName: "Quiz 2",
      rating: 2,
    });
  });

  it("stores a verdict on a recommended simulation", async () => {
    const s = await scenario();
    asUser(s.teacher.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "SIMULATION",
        subjectId: s.sim.id,
        subjectLabel: "Waves",
        attemptId: s.attempt.id,
        rating: 5,
        comment: "Right topic, and the physics is correct.",
      }),
    );
    expect(res.status).toBe(201);
    const row = await prisma.contentFeedback.findFirstOrThrow();
    expect(row.audience).toBe("TEACHER");
    expect(row.attemptId).toBe(s.attempt.id);
  });

  it("keeps the student's verdict and the teacher's as separate rows", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s, { rating: 5 })));
    asUser(s.teacher.user.id, "TEACHER");
    await POST(
      postReq({
        subjectType: "SIMULATION",
        subjectId: s.sim.id,
        subjectLabel: "Waves",
        attemptId: s.attempt.id,
        rating: 1,
        comment: "They liked it, but it teaches the wrong thing.",
      }),
    );

    const rows = await prisma.contentFeedback.findMany({
      orderBy: { audience: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.audience, r.rating])).toEqual([
      ["STUDENT", 5],
      ["TEACHER", 1],
    ]);
  });

  it("refuses an attempt in a class the teacher does not own", async () => {
    const s = await scenario();
    const outsider = await createTeacher();
    asUser(outsider.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "MATERIAL",
        subjectLabel: "Chapter 3",
        attemptId: s.attempt.id,
        rating: 1,
        comment: "Not my class.",
      }),
    );
    expect(res.status).toBe(404);
    expect(await prisma.contentFeedback.count()).toBe(0);
  });

  it("refuses content that attempt never recommended", async () => {
    const s = await scenario();
    asUser(s.teacher.user.id, "TEACHER");

    const res = await POST(
      postReq({
        subjectType: "MATERIAL",
        subjectLabel: "Chapter 9",
        attemptId: s.attempt.id,
        rating: 1,
        comment: "Never shown to this student.",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("lets an admin rate any class's recommendations", async () => {
    const s = await scenario();
    const admin = await createAdmin();
    asUser(admin.id, "ADMIN");

    const res = await POST(
      postReq({
        subjectType: "MATERIAL",
        subjectLabel: "Chapter 3",
        attemptId: s.attempt.id,
        rating: 3,
        comment: "Reasonable pick for this quiz.",
      }),
    );
    expect(res.status).toBe(201);
    const row = await prisma.contentFeedback.findFirstOrThrow();
    expect(row.audience).toBe("TEACHER");
    expect(row.authorRole).toBe("ADMIN");
    expect(row.routedTeacherId).toBeNull();
  });
});

describe("GET /api/feedback/mine", () => {
  it("returns the caller's own verdict for an attempt", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    const res = await mineGet(
      getReq(`/api/feedback/mine?attemptId=${s.attempt.id}`),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].rating).toBe(4);
  });

  it("never returns another student's verdict", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    const other = await createStudent();
    asUser(other.user.id, "STUDENT");
    const res = await mineGet(
      getReq(`/api/feedback/mine?attemptId=${s.attempt.id}`),
    );
    expect((await res.json()).feedback).toEqual([]);
  });
});

describe("GET /api/feedback/summary", () => {
  it("gives a teacher their students' verdicts and their own, consolidated", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s, { rating: 2 })));
    asUser(s.teacher.user.id, "TEACHER");
    await POST(
      postReq({
        subjectType: "SIMULATION",
        subjectId: s.sim.id,
        subjectLabel: "Waves",
        rating: 4,
        comment: "Useful, if a little slow.",
      }),
    );

    const res = await summaryGet(getReq("/api/feedback/summary"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.overall.average).toBe(3);
    expect(body.byAudience.STUDENT.count).toBe(1);
    expect(body.byAudience.TEACHER.count).toBe(1);
    expect(body.bySubject).toHaveLength(1);
    expect(body.bySubject[0].count).toBe(2);
    expect(body.classes).toEqual([{ id: s.cls.id, name: "Physics 101" }]);
  });

  it("hides another teacher's feedback", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    const outsider = await createTeacher();
    asUser(outsider.user.id, "TEACHER");
    const res = await summaryGet(getReq("/api/feedback/summary"));
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.overall.average).toBeNull();
  });

  it("shows an admin everything, across teachers", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    const admin = await createAdmin();
    asUser(admin.id, "ADMIN");
    const res = await summaryGet(getReq("/api/feedback/summary"));
    const body = await res.json();
    expect(body.viewerRole).toBe("ADMIN");
    expect(body.total).toBe(1);
  });

  it("applies the rating filter", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s, { rating: 4 })));

    asUser(s.teacher.user.id, "TEACHER");
    const match = await summaryGet(getReq("/api/feedback/summary?rating=4"));
    expect((await match.json()).total).toBe(1);
    const miss = await summaryGet(getReq("/api/feedback/summary?rating=1"));
    expect((await miss.json()).total).toBe(0);
  });

  it("refuses a student — the consolidated view is staff-only", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    const res = await summaryGet(getReq("/api/feedback/summary"));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/feedback/export", () => {
  it("downloads a teacher's own scope as CSV", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    asUser(s.teacher.user.id, "TEACHER");
    const res = await exportGet(getReq("/api/feedback/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    const csv = await res.text();
    expect(csv).toContain("Helped me see the phase shift.");
    expect(csv).toContain("Physics 101");
  });

  it("exports the per-subject summary view", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    asUser(s.teacher.user.id, "TEACHER");
    const res = await exportGet(getReq("/api/feedback/export?view=summary"));
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toContain("Average Rating");
    expect(csv).toContain("SIMULATION,Waves");
  });

  it("never exports rows outside the caller's scope", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    await POST(postReq(studentSimBody(s)));

    const outsider = await createTeacher();
    asUser(outsider.user.id, "TEACHER");
    const csv = await (await exportGet(getReq("/api/feedback/export"))).text();
    expect(csv).not.toContain("Helped me see the phase shift.");
  });

  it("refuses a student", async () => {
    const s = await scenario();
    asUser(s.student.user.id, "STUDENT");
    const res = await exportGet(getReq("/api/feedback/export"));
    expect(res.status).toBe(403);
  });
});
