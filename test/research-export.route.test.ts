import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import JSZip from "jszip";
import { readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", () => ({ getS3ObjectAsString: vi.fn() }));

import { GET } from "@/app/api/admin/research-export/route";
import { createResearchExport, researchCsvRow } from "@/lib/research-export";
import { auth } from "@/lib/auth";
import { getS3ObjectAsString } from "@/lib/storage";
import { prisma } from "@/lib/prisma";
import { parseCsvRecords } from "@/lib/concept-csv";
import {
  RESEARCH_EXPORT_CONFIG_FIELDS,
  RESEARCH_EXPORT_FIELDS,
  RESEARCH_EXPORT_FIELD_DOCS,
  RESEARCH_EXPORT_TABLE_SCOPES,
} from "@/lib/research-export-fields";
import {
  resetDb,
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
} from "./db";

const request = () =>
  new NextRequest("http://localhost/api/admin/research-export");

async function records(zip: JSZip, file: string) {
  const [headers, ...rows] = parseCsvRecords(
    await zip.file(file)!.async("string"),
  );
  return rows.map((row) =>
    Object.fromEntries(headers.map((header, i) => [header, row[i]])),
  );
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(auth).mockReset();
  vi.mocked(getS3ObjectAsString).mockReset();
});

afterAll(() => prisma.$disconnect());

describe("research CSV encoding", () => {
  it("quotes multiline/free text, guards formulas, and retains negative numbers", () => {
    expect(
      researchCsvRow(['a,"b"\nc', "=1+1", "  @SUM(1)", -2.5, null, true]),
    ).toBe('"a,""b""\nc","\t=1+1","\t  @SUM(1)",-2.5,,true\r\n');
  });
});

describe("research export field docs", () => {
  it("only documents exported columns, and documents every telemetry column", () => {
    for (const [model, docs] of Object.entries(RESEARCH_EXPORT_FIELD_DOCS)) {
      const exported =
        RESEARCH_EXPORT_FIELDS[
          model as keyof typeof RESEARCH_EXPORT_FIELDS
        ].split(" ");
      expect(exported).toEqual(expect.arrayContaining(Object.keys(docs!)));
    }
    expect(
      Object.keys(RESEARCH_EXPORT_FIELD_DOCS.LearningResourceSession!).sort(),
    ).toEqual(RESEARCH_EXPORT_FIELDS.LearningResourceSession.split(" ").sort());
  });
});

describe("research export table scopes", () => {
  it("classifies every exported table as data or config, and nothing else", () => {
    expect(Object.keys(RESEARCH_EXPORT_TABLE_SCOPES).sort()).toEqual(
      Object.keys(RESEARCH_EXPORT_FIELDS).sort(),
    );
    for (const scope of Object.values(RESEARCH_EXPORT_TABLE_SCOPES)) {
      expect(["data", "config"]).toContain(scope);
    }
  });

  it("tags every admin settings table as config", () => {
    for (const model of [
      "AiProvider",
      "AiModel",
      "AiUseCaseAssignment",
      "AssistantConfig",
      "GuardrailConfig",
      "EmailSender",
      "ResearchEmailTemplate",
      "ConsentExportSettings",
      "TeacherRegistrationCode",
      "PressureTestResult",
    ] as const) {
      expect(RESEARCH_EXPORT_TABLE_SCOPES[model]).toBe("config");
    }
  });

  it("only strips config columns that are actually exported from data tables", () => {
    for (const [model, fields] of Object.entries(
      RESEARCH_EXPORT_CONFIG_FIELDS,
    )) {
      const name = model as keyof typeof RESEARCH_EXPORT_FIELDS;
      expect(RESEARCH_EXPORT_TABLE_SCOPES[name]).toBe("data");
      expect(RESEARCH_EXPORT_FIELDS[name].split(" ")).toEqual(
        expect.arrayContaining([...fields!]),
      );
    }
  });
});

describe("admin research export", () => {
  it.each([null, "TEACHER", "STUDENT"])(
    "rejects caller %s before reading any data",
    async (role) => {
      vi.mocked(auth).mockResolvedValue(
        role ? ({ user: { id: "user", role } } as never) : (null as never),
      );
      expect((await GET(request())).status).toBe(role ? 403 : 401);
      expect(getS3ObjectAsString).not.toHaveBeenCalled();
    },
  );

  it("downloads complete, joined CSVs including consent declines, archived results, and surveys, without credentials", async () => {
    const { teacher, user: teacherUser } = await createTeacher();
    const { student, user } = await createStudent();
    const cls = await createClass(teacher.id);
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: student.id },
    });
    const { quiz, question } = await createPublishedQuiz({
      classId: cls.id,
      teacherId: teacher.id,
    });
    const completedAt = new Date("2026-10-01T12:34:56.123Z");
    const attempt = await prisma.quizAttempt.create({
      data: {
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        score: 100,
        completedAt,
      },
    });
    await prisma.quizAnswer.create({
      data: {
        quizAttemptId: attempt.id,
        questionId: question.id,
        selectedOptionId: question.options[1].id,
        isCorrect: true,
      },
    });
    await prisma.examResult.create({
      data: {
        quizAttemptId: "deleted-attempt",
        studentId: "deleted-student",
        classId: "deleted-class",
        quizId: "deleted-quiz",
        className: "Archived class",
        topicName: "Mechanics",
        quizName: "Archived quiz",
        score: 50,
        correctCount: 1,
        totalCount: 2,
        completedAt,
        reviewSnapshot: '{"questions":[]}',
      },
    });
    await prisma.learningResourceSession.create({
      data: {
        studentId: student.id,
        materialId: "deleted-material",
        materialTitle: "Archived notes",
        classId: cls.id,
        quizId: quiz.id,
        attemptId: attempt.id,
        surface: "results_recommendation",
        recommended: true,
        pageStart: 2,
        pageEnd: 4,
        dwellMs: 12_345,
        clickCount: 3,
        pagesViewed: 2,
        pagesViewedJson: '{"2":5000,"3":7345}',
      },
    });
    await prisma.invitation.create({
      data: { classId: cls.id, token: "INVITATION_SECRET" },
    });
    await prisma.teacherRegistrationCode.create({
      data: { code: "REGISTRATION_SECRET" },
    });
    await prisma.aiProvider.create({
      data: {
        name: "Research provider",
        providerType: "openai",
        apiKeyEnc: "API_KEY_SECRET",
        apiKeyIv: "IV_SECRET",
        apiKeyTag: "TAG_SECRET",
      },
    });
    const consentForm = await prisma.consentFormVersion.create({
      data: {
        role: "STUDENT",
        version: "v1",
        title: "Consent",
        bodyHtml: "Text",
      },
    });
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        formVersionId: consentForm.id,
        role: "STUDENT",
        decision: "DECLINE",
        signatureTypedName: "Student",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "Student",
        signerEmailSnapshot: user.email,
      },
    });
    const form = await prisma.surveyForm.create({
      data: {
        kind: "PRE",
        role: "STUDENT",
        title: "Pre survey",
        questions: JSON.stringify([
          { id: "q1", type: "text", text: "How was learning?" },
          { id: "q2", type: "multi", text: "Select topics" },
        ]),
      },
    });
    const response = await prisma.surveyResponse.create({
      data: {
        formId: form.id,
        userId: user.id,
        kind: "PRE",
        role: "STUDENT",
        answers: JSON.stringify({
          q1: 'Helpful, with "examples"\nand practice',
          q2: ["A", "B"],
        }),
        nameSnapshot: "Student",
        emailSnapshot: user.email,
      },
    });
    await prisma.surveyInvite.create({
      data: {
        formId: form.id,
        tokenHash: "SURVEY_TOKEN_SECRET",
        email: user.email,
        name: "Student",
      },
    });
    await prisma.consentEmailDelivery.create({
      data: {
        kind: "CONSENT_CONFIRMATION",
        recipient: user.email,
        payload: '{"url":"SECRET_LINK"}',
      },
    });
    const campaign = await prisma.researchEmailCampaign.create({
      data: {
        kind: "POST_SURVEY",
        replyTo: teacherUser.email,
        appOrigin: "http://localhost",
        scheduledAt: completedAt,
      },
    });
    await prisma.researchEmailDelivery.create({
      data: {
        campaignId: campaign.id,
        recipient: user.email,
        variant: "STUDENT",
        vars: '{"surveyLink":"SURVEY_LINK_SECRET"}',
      },
    });

    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    } as never);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="talent-research-.*\.zip"/,
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBe(Number(res.headers.get("content-length")));
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(
      await zip.file("manifest.json")!.async("string"),
    );
    expect(manifest.requestedById).toBe("admin-1");
    expect(manifest.files.length).toBeGreaterThan(60);
    for (const file of manifest.files) {
      expect(zip.file(file.name)).not.toBeNull();
      expect((await records(zip, file.name)).length).toBe(file.rows);
    }
    expect(await records(zip, "user.csv")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: user.id, email: user.email }),
      ]),
    );
    expect((await records(zip, "quiz_attempt.csv"))[0]).toMatchObject({
      id: attempt.id,
      studentId: student.id,
      quizId: quiz.id,
      completedAt: completedAt.toISOString(),
    });
    expect((await records(zip, "quiz_answer.csv"))[0]).toMatchObject({
      quizAttemptId: attempt.id,
      questionId: question.id,
      isCorrect: "true",
    });
    expect((await records(zip, "question.csv"))[0].quizId).toBe(quiz.id);
    expect((await records(zip, "topic.csv"))[0].teacherId).toBe(teacher.id);
    expect((await records(zip, "exam_result.csv"))[0].quizName).toBe(
      "Archived quiz",
    );
    expect((await records(zip, "consent_record.csv"))[0].decision).toBe(
      "DECLINE",
    );
    expect(await records(zip, "survey_answers.csv")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          responseId: response.id,
          formId: form.id,
          questionId: "q2",
          answerJson: '["A","B"]',
        }),
      ]),
    );
    expect((await records(zip, "survey_questions.csv"))[0]).toMatchObject({
      formId: form.id,
      questionId: "q1",
      position: "1",
      text: "How was learning?",
    });
    expect(
      (await records(zip, "learning_resource_session.csv"))[0],
    ).toMatchObject({
      studentId: student.id,
      materialId: "deleted-material",
      materialTitle: "Archived notes",
      attemptId: attempt.id,
      surface: "results_recommendation",
      recommended: "true",
      pageStart: "2",
      pageEnd: "4",
      dwellMs: "12345",
      clickCount: "3",
      pagesViewedJson: '{"2":5000,"3":7345}',
    });
    expect(await records(zip, "data_dictionary.csv")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "quiz_answer.csv",
          column: "quizAttemptId",
          references: "QuizAttempt.id",
        }),
        expect.objectContaining({
          file: "learning_resource_session.csv",
          column: "dwellMs",
          description: expect.stringContaining("tab visible"),
        }),
      ]),
    );
    for (const name of [
      "password_reset_token.csv",
      "smtp_config.csv",
      "backup_config.csv",
      "pressure_result_token.csv",
    ])
      expect(zip.file(name)).toBeNull();
    const contents = (
      await Promise.all(
        Object.values(zip.files).map((file) => file.async("string")),
      )
    ).join("\n");
    for (const secret of [
      user.hashedPassword,
      "INVITATION_SECRET",
      "REGISTRATION_SECRET",
      "API_KEY_SECRET",
      "IV_SECRET",
      "TAG_SECRET",
      "SURVEY_TOKEN_SECRET",
      "SECRET_LINK",
      "SURVEY_LINK_SECRET",
    ])
      expect(contents).not.toContain(secret);
  });

  it("includes all cold transcript turns alongside hot messages with timestamps", async () => {
    const hot = await prisma.assistantConversation.create({
      data: {
        userId: "deleted-user",
        audience: "student",
        title: "Hot",
        messageCount: 1,
        messages: { create: { seq: 0, role: "user", content: "Hot question" } },
      },
    });
    const cold = await prisma.assistantConversation.create({
      data: {
        userId: "deleted-user",
        audience: "student",
        title: "Cold",
        messageCount: 2,
        archivedAt: new Date(),
        bucket: "archive",
        storageKey: "transcript.jsonl",
      },
    });
    vi.mocked(getS3ObjectAsString).mockResolvedValue(
      [
        JSON.stringify({ v: 1, conversationId: cold.id }),
        JSON.stringify({
          role: "user",
          content: "Cold question",
          createdAt: "2026-01-01T00:00:00.000Z",
          attachmentIds: [],
          attachmentNames: [],
        }),
        JSON.stringify({
          role: "assistant",
          content: "Cold answer",
          createdAt: "2026-01-01T00:00:01.000Z",
          attachmentIds: [],
          attachmentNames: [],
        }),
      ].join("\n"),
    );
    const result = await createResearchExport("admin");
    try {
      const zip = await JSZip.loadAsync(await readFile(result.path));
      const messages = await records(zip, "assistant_message.csv");
      expect(messages).toHaveLength(3);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId: hot.id,
            content: "Hot question",
          }),
          expect.objectContaining({
            id: `${cold.id}:1`,
            conversationId: cold.id,
            seq: "1",
            content: "Cold answer",
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
        ]),
      );
      expect(getS3ObjectAsString).toHaveBeenCalledWith(
        "archive",
        "transcript.jsonl",
      );
    } finally {
      await result.cleanup();
    }
    await expect(access(result.path)).rejects.toThrow();
  });

  it("uses a consistent snapshot even when the live database changes during export", async () => {
    await prisma.assistantConversation.create({
      data: {
        userId: "old-user",
        audience: "student",
        title: "Archived",
        messageCount: 0,
        archivedAt: new Date(),
        bucket: "archive",
        storageKey: "transcript",
      },
    });
    vi.mocked(getS3ObjectAsString).mockImplementation(async () => {
      await createStudent();
      return JSON.stringify({ v: 1 });
    });
    const result = await createResearchExport("admin");
    try {
      const zip = await JSZip.loadAsync(await readFile(result.path));
      expect(await records(zip, "user.csv")).toHaveLength(0);
      expect(await records(zip, "student.csv")).toHaveLength(0);
      expect(await prisma.user.count()).toBe(1);
    } finally {
      await result.cleanup();
    }
  });

  it("fails and removes temporary data when a cold transcript is unavailable", async () => {
    await prisma.assistantConversation.create({
      data: {
        userId: "old-user",
        audience: "student",
        title: "Missing",
        messageCount: 1,
        archivedAt: new Date(),
        bucket: "archive",
        storageKey: "missing",
      },
    });
    vi.mocked(getS3ObjectAsString).mockRejectedValue(
      new Error("Storage unavailable"),
    );
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith("talent-research-"),
    );
    await expect(createResearchExport("admin")).rejects.toThrow(
      "Storage unavailable",
    );
    expect(
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("talent-research-"),
      ),
    ).toEqual(before);
  });

  it("lets a research scientist download it and records the export in the audit log", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "researcher-1", role: "RESEARCHER", email: "r@x.org" },
    } as never);
    const res = await GET(request());
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    const audit = await prisma.systemLog.findMany({
      where: { category: "AUDIT", type: "DATA_EXPORT" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].userId).toBe("researcher-1");
    expect(JSON.parse(audit[0].metadata!)).toMatchObject({
      dataset: "research export ZIP",
      role: "RESEARCHER",
    });
  });

  it("gives a research scientist an archive without deployment configuration, and an admin the full one", async () => {
    await prisma.teacher.update({
      where: { id: (await createTeacher()).teacher.id },
      data: { emailDailyLimit: 7, emailMonthlyLimit: 70 },
    });
    const provider = await prisma.aiProvider.create({
      data: { name: "Secret provider", providerType: "openai" },
    });
    const model = await prisma.aiModel.create({
      data: { providerId: provider.id, modelId: "secret-model" },
    });
    await prisma.aiUseCaseAssignment.create({
      data: {
        useCase: "TUTOR",
        providerId: provider.id,
        modelId: model.id,
      },
    });
    await prisma.guardrailConfig.create({
      data: { topicDescription: "SECRET_TOPIC" },
    });
    await prisma.assistantConfig.create({
      data: {
        id: "STUDENT",
        audience: "STUDENT",
        extraInstructions: "SECRET_INSTRUCTIONS",
      },
    });
    await prisma.emailSender.create({
      data: { purpose: "RESEARCH", localPart: "secret-sender" },
    });
    await prisma.researchEmailTemplate.create({
      data: { kind: "INTERVIEW", irbBody: "SECRET_TEMPLATE" },
    });
    await prisma.consentExportSettings.create({ data: {} });
    await prisma.teacherRegistrationCode.create({
      data: { code: "SECRET-CODE", label: "SECRET_LABEL" },
    });

    const configFiles = [
      "ai_provider.csv",
      "ai_model.csv",
      "ai_use_case_assignment.csv",
      "guardrail_config.csv",
      "assistant_config.csv",
      "email_sender.csv",
      "research_email_template.csv",
      "consent_export_settings.csv",
      "teacher_registration_code.csv",
      "pressure_test_result.csv",
      "resource_sample.csv",
    ];
    const secrets = [
      "Secret provider",
      "secret-model",
      "SECRET_TOPIC",
      "SECRET_INSTRUCTIONS",
      "secret-sender",
      "SECRET_TEMPLATE",
      "SECRET_LABEL",
    ];

    const researcher = await createResearchExport("researcher-1", undefined, {
      audience: "researcher",
    });
    try {
      const zip = await JSZip.loadAsync(await readFile(researcher.path));
      for (const file of configFiles) expect(zip.file(file)).toBeNull();
      const everything = (
        await Promise.all(
          Object.values(zip.files).map((entry) => entry.async("string")),
        )
      ).join("\n");
      for (const secret of secrets) expect(everything).not.toContain(secret);
      const [teacher] = await records(zip, "teacher.csv");
      expect(teacher).not.toHaveProperty("emailDailyLimit");
      expect(teacher).not.toHaveProperty("emailMonthlyLimit");
      expect(zip.file("user.csv")).not.toBeNull();
      expect(zip.file("consent_record.csv")).not.toBeNull();
      expect(zip.file("survey_response.csv")).not.toBeNull();
      const manifest = JSON.parse(
        await zip.file("manifest.json")!.async("string"),
      );
      expect(manifest.audience).toBe("researcher");
      expect(manifest.excludedModels).toEqual(
        expect.arrayContaining([
          "AiProvider",
          "AssistantConfig",
          "EmailSender",
        ]),
      );
      const dictionary = await zip.file("data_dictionary.csv")!.async("string");
      expect(dictionary).not.toContain("assistant_config.csv");
      expect(dictionary).not.toContain("emailDailyLimit");
      const readme = await zip.file("README.txt")!.async("string");
      expect(readme).toContain("research-scientist extract");
      expect(readme).toContain("AssistantConfig");
    } finally {
      await researcher.cleanup();
    }

    const admin = await createResearchExport("admin-1");
    try {
      const zip = await JSZip.loadAsync(await readFile(admin.path));
      for (const file of configFiles) expect(zip.file(file)).not.toBeNull();
      const everything = (
        await Promise.all(
          Object.values(zip.files).map((entry) => entry.async("string")),
        )
      ).join("\n");
      for (const secret of secrets) expect(everything).toContain(secret);
      const [teacher] = await records(zip, "teacher.csv");
      expect(teacher.emailDailyLimit).toBe("7");
      const manifest = JSON.parse(
        await zip.file("manifest.json")!.async("string"),
      );
      expect(manifest.audience).toBe("admin");
      expect(manifest.excludedModels).not.toContain("AiProvider");
    } finally {
      await admin.cleanup();
    }
  });

  it("serves the research scientist's scoped archive through the route", async () => {
    await prisma.assistantConfig.create({
      data: {
        id: "STUDENT",
        audience: "STUDENT",
        extraInstructions: "SECRET_INSTRUCTIONS",
      },
    });
    vi.mocked(auth).mockResolvedValue({
      user: { id: "researcher-1", role: "RESEARCHER" },
    } as never);
    const res = await GET(request());
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    expect(zip.file("assistant_config.csv")).toBeNull();
    expect(zip.file("user.csv")).not.toBeNull();
  });

  it("cancels before generating data when the client has disconnected", async () => {
    await expect(
      createResearchExport("admin", AbortSignal.abort()),
    ).rejects.toThrow();
  });
});
