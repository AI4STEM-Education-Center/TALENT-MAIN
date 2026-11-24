import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  resetDb,
  createTeacher,
  createStudent,
  createAdmin,
  createClass,
} from "./db";
import { GET as teacherList } from "@/app/api/teacher/coach-reviews/route";
import {
  GET as teacherDetail,
  PATCH as teacherPatch,
} from "@/app/api/teacher/coach-reviews/[sessionId]/route";
import { GET as adminExport } from "@/app/api/admin/coach-export/route";
import {
  formatCsvCell,
  redactFreeText,
  pseudonymizeId,
} from "@/lib/wrong-answer-coach-export";

const mockAuth = vi.mocked(auth);

async function seedReviewAndExportData() {
  const { user: t1User, teacher: t1 } = await createTeacher();
  const { user: t2User, teacher: t2 } = await createTeacher();
  const adminUser = await createAdmin();
  const { user: s1User, student: s1 } = await createStudent();
  const { user: s2User, student: s2 } = await createStudent();

  const cls1 = await createClass(t1.id, "Class One");
  const cls2 = await createClass(t2.id, "Class Two");

  await prisma.misconception.upsert({
    where: { misconceptionId: "M1" },
    update: {},
    create: {
      misconceptionId: "M1",
      statement: "Sample misconception M1",
      deprecated: false,
    },
  });

  // Active consent form: s1 AGREEs, s2 DECLINEs
  const form = await prisma.consentFormVersion.create({
    data: {
      role: "STUDENT",
      version: "v2.0",
      title: "Study Consent",
      bodyHtml: "<p>Terms</p>",
      isActive: true,
    },
  });
  await prisma.consentRecord.create({
    data: {
      userId: s1User.id,
      role: "STUDENT",
      formVersionId: form.id,
      decision: "AGREE",
      signatureTypedName: "Stu Student",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      deviceType: "desktop",
      signerNameSnapshot: "Stu Student",
      signerEmailSnapshot: s1User.email,
    },
  });
  await prisma.consentRecord.create({
    data: {
      userId: s2User.id,
      role: "STUDENT",
      formVersionId: form.id,
      decision: "DECLINE",
      signatureTypedName: "Non Consent",
      ipAddress: "127.0.0.1",
      userAgent: "vitest",
      deviceType: "desktop",
      signerNameSnapshot: "Non Consent",
      signerEmailSnapshot: s2User.email,
    },
  });

  const topic = await prisma.topic.create({
    data: { name: "Mechanics", teacherId: t1.id },
  });
  const quiz = await prisma.quiz.create({
    data: { name: "Quiz 1", topicId: topic.id, teacherId: t1.id },
  });

  const snapshotJson = JSON.stringify({
    originalQuestion: {
      questionId: "q1",
      sourceHash: "h1",
      text: "Original Q",
      correctOptionId: "o1",
      correctOptionText: "Right",
      optionLabels: [],
      keyPoints: ["Key idea"],
    },
    secondQuestion: {
      id: "v1",
      sourceQuestionId: "q1",
      text: "Q2",
      options: [],
    },
    heldOutQuestion: {
      id: "v2",
      sourceQuestionId: "q1",
      text: "Q3",
      options: [],
    },
    misconceptionCatalog: [
      { code: "M1", statement: "Sample misconception M1" },
    ],
    courseSnippets: [],
  });

  // Session 1: Consenting student in Teacher 1's class, COMPLETED + flagged
  const ses1 = await prisma.wrongAnswerCoachSession.create({
    data: {
      attemptId: "att-1",
      examResultId: "er-1",
      studentId: s1.id,
      studentUserId: s1User.id,
      classId: cls1.id,
      quizId: quiz.id,
      questionId: "q1",
      questionIndex: 0,
      check3VersionId: "v-c3",
      heldOutVersionId: "v-ho",
      chosenOptionText: "Wrong",
      questionSnapshotJson: snapshotJson,
      state: "COMPLETED",
      completedAt: new Date(),
      explanationText:
        "=SUM(A1:A5) My name is Stu Student, email stu@uni.edu, ID 123456789",
      diagnosis: "SLIP",
      decisionTableRow: 2,
      flagsJson: JSON.stringify(["CHECK2_DISAGREEMENT"]),
      hasFlags: true,
      reviewStatus: "PENDING",
      researchMeta: {
        create: {
          studentStudyCode: "P-TEST0001",
          consentStatus: "AGREE",
          consentFormVersion: "v2.0",
          protocolRevision: "2026.1",
        },
      },
      messages: {
        create: [
          {
            seq: 1,
            role: "student",
            kind: "STUDENT_EXPLANATION",
            content: "Reach me at stu@uni.edu or 811-123-456",
          },
          {
            seq: 2,
            role: "assistant",
            kind: "TUTORING_MESSAGE",
            content:
              "Good effort Stu Student, avoid emailing stu@uni.edu here.",
          },
        ],
      },
    },
  });

  // Session 2: Non-consenting student in Teacher 1's class, INCOMPLETE (diagnosis === null) + crisis flag
  const ses2 = await prisma.wrongAnswerCoachSession.create({
    data: {
      attemptId: "att-2",
      examResultId: "er-2",
      studentId: s2.id,
      studentUserId: s2User.id,
      classId: cls1.id,
      quizId: quiz.id,
      questionId: "q1",
      questionIndex: 0,
      check3VersionId: "v-c3",
      heldOutVersionId: "v-ho",
      chosenOptionText: "Wrong",
      questionSnapshotJson: snapshotJson,
      state: "INCOMPLETE",
      endedReason: "SAFETY_STOP",
      diagnosis: null,
      flagsJson: JSON.stringify([
        "PERSONAL_SUPPORT_NEEDED",
        "INCOMPLETE_SESSION",
      ]),
      hasFlags: true,
      reviewStatus: "PENDING",
      researchMeta: {
        create: {
          studentStudyCode: "P-TEST0002",
          consentStatus: "DECLINE",
          consentFormVersion: "v2.0",
          protocolRevision: "2026.1",
        },
      },
    },
  });

  // Session 3: Another class owned by Teacher 2
  const ses3 = await prisma.wrongAnswerCoachSession.create({
    data: {
      attemptId: "att-3",
      examResultId: "er-3",
      studentId: s1.id,
      studentUserId: s1User.id,
      classId: cls2.id,
      quizId: quiz.id,
      questionId: "q1",
      questionIndex: 0,
      check3VersionId: "v-c3",
      heldOutVersionId: "v-ho",
      chosenOptionText: "Wrong",
      questionSnapshotJson: snapshotJson,
      state: "COMPLETED",
      diagnosis: "KNOWLEDGE_GAP",
      decisionTableRow: 14,
      flagsJson: JSON.stringify(["CHECK2_TIE"]),
      hasFlags: true,
      reviewStatus: "PENDING",
    },
  });

  return { t1User, t2User, adminUser, ses1, ses2, ses3, cls1 };
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Teacher review scoping, IRB isolation, and diagnosis===null gating", () => {
  it("scopes teacher list to own classes, pins PERSONAL_SUPPORT_NEEDED first, and NEVER leaks consent/study codes", async () => {
    const { t1User, ses1, ses2, ses3 } = await seedReviewAndExportData();
    mockAuth.mockResolvedValue({
      user: { id: t1User.id, role: "TEACHER" },
    } as never);

    const listRes = await teacherList(
      new NextRequest("http://localhost/api/teacher/coach-reviews"),
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.sessions.map((s: { id: string }) => s.id)).toEqual([
      ses2.id, // PERSONAL_SUPPORT_NEEDED pinned first!
      ses1.id,
    ]);
    // Must not see Teacher 2's session
    expect(
      listBody.sessions.some((s: { id: string }) => s.id === ses3.id),
    ).toBe(false);

    // IRB privacy invariant: never leak consentStatus, studentStudyCode, or researchMeta
    const serializedList = JSON.stringify(listBody);
    expect(serializedList).not.toContain("consentStatus");
    expect(serializedList).not.toContain("studentStudyCode");
    expect(serializedList).not.toContain("P-TEST0001");
    expect(serializedList).not.toContain("researchMeta");

    // Detail view also strips all researchMeta and blocks cross-teacher access
    const detailRes = await teacherDetail(
      new NextRequest(`http://localhost/api/teacher/coach-reviews/${ses1.id}`),
      { params: Promise.resolve({ sessionId: ses1.id }) },
    );
    expect(detailRes.status).toBe(200);
    const serializedDetail = JSON.stringify(await detailRes.json());
    expect(serializedDetail).not.toContain("consentStatus");
    expect(serializedDetail).not.toContain("P-TEST0001");

    const forbiddenRes = await teacherDetail(
      new NextRequest(`http://localhost/api/teacher/coach-reviews/${ses3.id}`),
      { params: Promise.resolve({ sessionId: ses3.id }) },
    );
    expect(forbiddenRes.status).toBe(404);
  });

  it("blocks diagnosis agreement/override when diagnosis === null, and preserves deterministic diagnosis on valid override", async () => {
    const { t1User, ses1, ses2 } = await seedReviewAndExportData();
    mockAuth.mockResolvedValue({
      user: { id: t1User.id, role: "TEACHER" },
    } as never);

    // ses2 has diagnosis === null -> AGREE_DIAGNOSIS must fail with 400
    const badRes = await teacherPatch(
      new NextRequest(`http://localhost/api/teacher/coach-reviews/${ses2.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewDecision: "AGREE_DIAGNOSIS" }),
      }),
      { params: Promise.resolve({ sessionId: ses2.id }) },
    );
    expect(badRes.status).toBe(400);

    // ses2 allows ESCALATED_FOLLOWUP
    const okEsc = await teacherPatch(
      new NextRequest(`http://localhost/api/teacher/coach-reviews/${ses2.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewDecision: "ESCALATED_FOLLOWUP",
          reviewNotes: "Followed up with counseling.",
        }),
      }),
      { params: Promise.resolve({ sessionId: ses2.id }) },
    );
    expect(okEsc.status).toBe(200);

    // ses1 valid OVERRIDE_MISCONCEPTION leaves deterministic diagnosis intact
    const okOver = await teacherPatch(
      new NextRequest(`http://localhost/api/teacher/coach-reviews/${ses1.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewDecision: "OVERRIDE_MISCONCEPTION",
          reviewOverrideCode: "M1",
        }),
      }),
      { params: Promise.resolve({ sessionId: ses1.id }) },
    );
    expect(okOver.status).toBe(200);
    const updated = await prisma.wrongAnswerCoachSession.findUnique({
      where: { id: ses1.id },
    });
    expect(updated?.diagnosis).toBe("SLIP"); // Never mutated!
    expect(updated?.reviewDecision).toBe("OVERRIDE_MISCONCEPTION");
    expect(updated?.reviewOverrideCode).toBe("M1");
  });
});

describe("Admin IRB research export", () => {
  it("exports ONLY consenting students, redacts PII, pseudonymizes IDs, escapes CSV formulas, and logs audit event", async () => {
    const { adminUser, ses1, cls1 } = await seedReviewAndExportData();
    mockAuth.mockResolvedValue({
      user: { id: adminUser.id, role: "ADMIN" },
    } as never);

    // Summary
    const sumRes = await adminExport(
      new NextRequest(
        `http://localhost/api/admin/coach-export?format=summary&classId=${cls1.id}&includeIncomplete=true`,
      ),
    );
    expect(sumRes.status).toBe(200);
    expect(await sumRes.json()).toMatchObject({
      totalMatchingSessions: 2,
      consentingExportableSessions: 1,
      excludedNonConsentingSessions: 1,
    });

    // JSONL export (default redacted)
    const jsonlRes = await adminExport(
      new NextRequest(
        `http://localhost/api/admin/coach-export?format=jsonl&classId=${cls1.id}&includeIncomplete=true`,
      ),
    );
    expect(jsonlRes.status).toBe(200);
    expect(jsonlRes.headers.get("Cache-Control")).toBe("no-store, private");
    const lines = (await jsonlRes.text()).trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.studentStudyCode).toBe("P-TEST0001");
    expect(rec.sessionId).toBe(pseudonymizeId("ses", ses1.id));
    expect(rec.sessionId).not.toBe(ses1.id);
    expect(rec.containsUnredactedFreeText).toBe(false);
    expect(rec.explanationText).toContain("[REDACTED_EMAIL]");
    expect(rec.explanationText).toContain("[REDACTED_ID]");
    expect(rec.explanationText).toContain("[REDACTED_NAME]");
    expect(rec.explanationText).not.toContain("stu@uni.edu");
    expect(rec.messages[0].content).toContain("[REDACTED_EMAIL]");
    expect(rec.messages[0].content).toContain("[REDACTED_ID]");
    expect(rec.messages[1].content).toContain("[REDACTED_EMAIL]");
    expect(rec.messages[1].content).toContain("[REDACTED_NAME]");
    expect(rec.messages[1].content).not.toContain("stu@uni.edu");

    // CSV export formula neutralization + containsUnredactedFreeText column
    const csvRes = await adminExport(
      new NextRequest(
        `http://localhost/api/admin/coach-export?format=csv&classId=${cls1.id}`,
      ),
    );
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).toContain("containsUnredactedFreeText");
    expect(csvText).toContain("'=SUM(A1:A5)");

    // Date-only `to` bound includes the full UTC day; invalid date returns 400
    const todayUtc = new Date().toISOString().slice(0, 10);
    const datedRes = await adminExport(
      new NextRequest(
        `http://localhost/api/admin/coach-export?format=summary&classId=${cls1.id}&to=${todayUtc}`,
      ),
    );
    expect(datedRes.status).toBe(200);
    expect((await datedRes.json()).consentingExportableSessions).toBe(1);

    const invalidDateRes = await adminExport(
      new NextRequest(
        `http://localhost/api/admin/coach-export?format=summary&from=not-a-date`,
      ),
    );
    expect(invalidDateRes.status).toBe(400);

    // Audit log written
    const logs = await prisma.systemLog.findMany({
      where: { type: "COACH_RESEARCH_EXPORT_DOWNLOAD" },
    });
    expect(logs.length).toBe(2);
  });

  it("unit checks formatCsvCell and redactFreeText edge cases", () => {
    expect(formatCsvCell("=1+1")).toBe("'=1+1");
    expect(formatCsvCell("+cmd")).toBe("'+cmd");
    expect(formatCsvCell("-2+3")).toBe("'-2+3");
    expect(formatCsvCell("@SUM")).toBe("'@SUM");
    expect(formatCsvCell('hello, "world"')).toBe('"hello, ""world"""');
    expect(
      redactFreeText("Call Alice Smith at 555-123-4567", ["Alice Smith"]),
    ).toBe("Call [REDACTED_NAME] at [REDACTED_PHONE]");
  });
});
