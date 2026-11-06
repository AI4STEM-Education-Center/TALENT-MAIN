import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveAssistantSettings } from "@/lib/assistant/config";
import { invalidateSttSettingsCache, saveSttSettings } from "@/lib/stt/config";
import { POST as POST_STT } from "@/app/api/assistant/stt/route";
import {
  GET as GET_ADMIN_STT,
  PUT as PUT_ADMIN_STT,
} from "@/app/api/admin/stt/route";
import { createAdmin, createStudent, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);

function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  invalidateSttSettingsCache();
  mockAuth.mockReset();
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/assistant/stt & /api/admin/stt", () => {
  it("rejects unauthenticated callers with 401 and disabled assistants with 503", async () => {
    mockAuth.mockResolvedValue(null as never);
    const unauth = await POST_STT(
      postJson("http://localhost/api/assistant/stt", { action: "presign" }),
    );
    expect(unauth.status).toBe(401);

    const { user } = await createStudent();
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);
    await saveAssistantSettings("student", { enabled: false });

    const disabledRes = await POST_STT(
      postJson("http://localhost/api/assistant/stt", { action: "presign" }),
    );
    expect(disabledRes.status).toBe(503);
  });

  it("returns a short-lived SigV4-presigned WebSocket URL and respects admin STT settings", async () => {
    const { user } = await createStudent();
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);
    await saveAssistantSettings("student", { enabled: true });

    const res = await POST_STT(
      postJson("http://localhost/api/assistant/stt", {
        action: "presign",
        surface: "student_assistant",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toMatch(
      /^wss:\/\/transcribestreaming\.us-east-1\.amazonaws\.com:8443\/stream-transcription-websocket\?/,
    );
    expect(body.languageCode).toBe("en-US");
    expect(body.sampleRate).toBe(16000);

    // Update settings via admin API to Mandarin Chinese (zh-CN) with auto language identification
    const admin = await createAdmin();
    mockAuth.mockResolvedValue({
      user: { id: admin.id, role: "ADMIN" },
    } as never);

    const putRes = await PUT_ADMIN_STT(
      new Request("http://localhost/api/admin/stt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            enabled: true,
            languageCode: "zh-CN",
            identifyLanguage: true,
            languageOptions: ["en-US", "zh-CN"],
            enablePartialResultsStabilization: true,
            partialResultsStability: "high",
          },
        }),
      }),
    );
    expect(putRes.status).toBe(200);

    // Presign again as student and verify updated config is reflected
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "STUDENT" },
    } as never);
    const zhRes = await POST_STT(
      postJson("http://localhost/api/assistant/stt", { action: "presign" }),
    );
    const zhBody = await zhRes.json();
    expect(zhBody.identifyLanguage).toBe(true);
    expect(zhBody.url).toContain("identify-language=true");
    expect(zhBody.url).toContain("language-options=en-US%2Czh-CN");
    expect(zhBody.url).toContain("partial-results-stability=high");
  });

  it("503s when STT is disabled in admin settings", async () => {
    const { user } = await createTeacher();
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);
    await saveAssistantSettings("teacher", { enabled: true });
    await saveSttSettings({ enabled: false });

    const res = await POST_STT(
      postJson("http://localhost/api/assistant/stt", {
        action: "presign",
        surface: "teacher_assistant",
      }),
    );
    expect(res.status).toBe(503);
  });

  it("records completed STT session duration and aggregates per-user usage in GET /api/admin/stt", async () => {
    const student = await createStudent();
    const teacher = await createTeacher();
    const admin = await createAdmin();

    await saveAssistantSettings("student", { enabled: true });
    await saveAssistantSettings("teacher", { enabled: true });

    mockAuth.mockResolvedValue({
      user: { id: student.user.id, role: "STUDENT" },
    } as never);
    await POST_STT(
      postJson("http://localhost/api/assistant/stt", {
        action: "complete",
        surface: "student_assistant",
        durationMs: 4500,
        languageCode: "en-US",
      }),
    );
    await POST_STT(
      postJson("http://localhost/api/assistant/stt", {
        action: "complete",
        surface: "wrong_answer_coach",
        durationMs: 3200,
        languageCode: "en-US",
      }),
    );

    mockAuth.mockResolvedValue({
      user: { id: teacher.user.id, role: "TEACHER" },
    } as never);
    await POST_STT(
      postJson("http://localhost/api/assistant/stt", {
        action: "complete",
        surface: "teacher_assistant",
        durationMs: 6000,
        languageCode: "zh-CN",
      }),
    );

    // Query usage from Admin API
    mockAuth.mockResolvedValue({
      user: { id: admin.id, role: "ADMIN" },
    } as never);
    const adminRes = await GET_ADMIN_STT(
      new NextRequest("http://localhost/api/admin/stt"),
    );
    expect(adminRes.status).toBe(200);
    const data = await adminRes.json();

    expect(data.usage.totalSessions).toBe(3);
    expect(data.usage.totalDurationMs).toBe(13700);
    expect(data.usage.uniqueUsers).toBe(2);
    expect(data.usage.userSummaries[0]).toMatchObject({
      userName: "Stu Student",
      sessions: 2,
      totalDurationMs: 7700,
    });
    expect(data.usage.userSummaries[1]).toMatchObject({
      userName: "Tess Teacher",
      sessions: 1,
      totalDurationMs: 6000,
    });
  });
});
