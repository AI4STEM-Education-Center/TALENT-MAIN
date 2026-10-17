import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as exportGET } from "@/app/api/admin/ai-config/export/route";
import { POST as importPOST } from "@/app/api/admin/ai-config/import/route";
import { GET as LOGS } from "@/app/api/admin/logs/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logSystemEvent } from "@/lib/system-log";
import { createResearchExport } from "@/lib/research-export";
import {
  RESEARCHER_WITHHELD_MESSAGE,
  toResearcherSafeLog,
} from "@/lib/system-log-visibility";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const asAdmin = () =>
  mockAuth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
const asResearcher = () =>
  mockAuth.mockResolvedValue({
    user: { id: "researcher-1", role: "RESEARCHER" },
  } as never);

/** Provider, model and use-case strings that must never reach a researcher. */
const CONFIG_STRINGS = ["Secret Provider", "secret-model-9", "pdf_description"];

async function seedAiConfig() {
  const provider = await prisma.aiProvider.create({
    data: { name: "Secret Provider", providerType: "openai" },
  });
  const model = await prisma.aiModel.create({
    data: { providerId: provider.id, modelId: "secret-model-9" },
  });
  await prisma.aiUseCaseAssignment.create({
    data: {
      useCase: "pdf_description",
      providerId: provider.id,
      modelId: model.id,
    },
  });
}

/** Run the real AI-config export + import so their own log writes happen. */
async function logConfigEvents() {
  await seedAiConfig();
  asAdmin();
  const bundle = await (await exportGET()).json();
  const res = await importPOST(
    new NextRequest("http://localhost/api/admin/ai-config/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle, options: { replaceExisting: true } }),
    }),
  );
  expect(res.status).toBe(200);
  // A second config-type event: a failed safety check names the model.
  await logSystemEvent({
    category: "GUARDRAIL",
    type: "SAFETY_CHECK_UNAVAILABLE",
    severity: "WARNING",
    message: "Safety check skipped on assistant (secret-model-9): timeout",
  });
  // A non-config event whose raw error text happens to embed config.
  await logSystemEvent({
    category: "WORKER",
    type: "JOB_FAILED",
    severity: "ERROR",
    message: "Simulation job failed: 404 model secret-model-9 not found",
  });
  // A safe event that must stay readable.
  await logSystemEvent({
    category: "AUTH",
    type: "LOGIN_SUCCESS",
    message: "tess (TEACHER) signed in",
  });
  // The import/export routes log fire-and-forget; wait for both rows.
  for (let i = 0; i < 50; i++) {
    const n = await prisma.systemLog.count({
      where: { type: { in: ["AI_CONFIG_IMPORT", "AI_CONFIG_EXPORT"] } },
    });
    if (n === 2) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const imported = await prisma.systemLog.findFirstOrThrow({
    where: { type: "AI_CONFIG_IMPORT" },
  });
  // Precondition: the import report really carries the config strings.
  for (const s of CONFIG_STRINGS) expect(imported.metadata).toContain(s);
}

const logsRequest = (query = "") =>
  new NextRequest(`http://localhost/api/admin/logs${query}`);

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(() => prisma.$disconnect());

describe("toResearcherSafeLog", () => {
  it("drops config rows, always drops metadata, and withholds unvetted messages", () => {
    expect(
      toResearcherSafeLog({ type: "AI_CONFIG_IMPORT", message: "x" }),
    ).toBeNull();
    expect(
      toResearcherSafeLog({ type: "TEACHER_CODE_CREATED", message: "x" }),
    ).toBeNull();
    expect(
      toResearcherSafeLog({
        type: "LOGIN_SUCCESS",
        message: "tess signed in",
        metadata: '{"a":1}',
      }),
    ).toEqual({
      type: "LOGIN_SUCCESS",
      message: "tess signed in",
      metadata: null,
    });
    expect(
      toResearcherSafeLog({ type: "SOME_NEW_TYPE", message: "raw detail" }),
    ).toEqual({
      type: "SOME_NEW_TYPE",
      message: RESEARCHER_WITHHELD_MESSAGE,
      metadata: null,
    });
  });
});

describe("system log: research scientist vs admin", () => {
  it("GET /api/admin/logs hides AI config from a researcher but not from an admin", async () => {
    await logConfigEvents();

    asResearcher();
    const res = await LOGS(logsRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = JSON.stringify(body);
    for (const s of CONFIG_STRINGS) expect(text).not.toContain(s);
    const types = body.logs.map((l: { type: string }) => l.type);
    expect(types).not.toContain("AI_CONFIG_IMPORT");
    expect(types).not.toContain("AI_CONFIG_EXPORT");
    expect(types).not.toContain("SAFETY_CHECK_UNAVAILABLE");
    expect(types).toEqual(
      expect.arrayContaining(["LOGIN_SUCCESS", "JOB_FAILED"]),
    );
    expect(body.total).toBe(body.logs.length);
    for (const log of body.logs) expect(log.metadata).toBeNull();
    expect(text).toContain("tess (TEACHER) signed in");

    // Free-text search can't probe withheld text.
    const probe = await (await LOGS(logsRequest("?q=secret-model-9"))).json();
    expect(probe.logs).toHaveLength(0);

    asAdmin();
    const adminText = JSON.stringify(await (await LOGS(logsRequest())).json());
    for (const s of CONFIG_STRINGS) expect(adminText).toContain(s);
  });

  it("the researcher ZIP's system_log.csv uses the same projection; the admin ZIP keeps everything", async () => {
    await logConfigEvents();

    const researcher = await createResearchExport("researcher-1", undefined, {
      audience: "researcher",
    });
    try {
      const zip = await JSZip.loadAsync(await readFile(researcher.path));
      const log = await zip.file("system_log.csv")!.async("string");
      expect(log.split("\r\n")[0]).not.toContain("metadata");
      expect(log).toContain("tess (TEACHER) signed in");
      expect(log).toContain(RESEARCHER_WITHHELD_MESSAGE);
      expect(log).not.toContain("AI_CONFIG_IMPORT");
      const everything = (
        await Promise.all(
          Object.values(zip.files).map((entry) => entry.async("string")),
        )
      ).join("\n");
      for (const s of CONFIG_STRINGS) expect(everything).not.toContain(s);
      const manifest = JSON.parse(
        await zip.file("manifest.json")!.async("string"),
      );
      const logEntry = manifest.files.find(
        (f: { model: string }) => f.model === "SystemLog",
      );
      // Written rows only: LOGIN_SUCCESS + JOB_FAILED.
      expect(logEntry.rows).toBe(2);
      expect(logEntry.columns).not.toContain("metadata");
    } finally {
      await researcher.cleanup();
    }

    const admin = await createResearchExport("admin-1");
    try {
      const zip = await JSZip.loadAsync(await readFile(admin.path));
      const log = await zip.file("system_log.csv")!.async("string");
      expect(log).toContain("AI_CONFIG_IMPORT");
      for (const s of CONFIG_STRINGS) expect(log).toContain(s);
    } finally {
      await admin.cleanup();
    }
  });
});
