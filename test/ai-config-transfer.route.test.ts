import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as exportGET } from "@/app/api/admin/ai-config/export/route";
import { POST as importPOST } from "@/app/api/admin/ai-config/import/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { invalidateProviderCache } from "@/lib/ai-provider";
import { invalidateGuardrailSettings } from "@/lib/guardrail-settings";
import { saveAssistantSettings } from "@/lib/assistant/config";
import { ASSISTANT_AUDIENCES } from "@/lib/assistant/types";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const asAdmin = () =>
  mockAuth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
const asTeacher = () =>
  mockAuth.mockResolvedValue({ user: { id: "t-1", role: "TEACHER" } } as never);

function importReq(bundle: unknown, options: unknown = {}) {
  return new NextRequest("http://localhost/api/admin/ai-config/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle, options }),
  });
}

async function seedSite() {
  const enc = encryptApiKey("sk-dev-secret");
  const openai = await prisma.aiProvider.create({
    data: {
      name: "Dev OpenAI",
      providerType: "openai",
      apiKeyEnc: enc.encrypted,
      apiKeyIv: enc.iv,
      apiKeyTag: enc.tag,
      timeoutMs: 30_000,
    },
  });
  const gpt = await prisma.aiModel.create({
    data: { providerId: openai.id, modelId: "gpt-5.1", serviceTier: "flex" },
  });
  const local = await prisma.aiProvider.create({
    data: {
      name: "Local",
      providerType: "local",
      baseUrl: "http://localhost:11434/v1",
    },
  });
  const llama = await prisma.aiModel.create({
    data: { providerId: local.id, modelId: "llama-3.3-70b" },
  });
  await prisma.aiUseCaseAssignment.create({
    data: {
      useCase: "pdf_description",
      providerId: openai.id,
      modelId: gpt.id,
      thinkingLevel: "high",
    },
  });
  await prisma.aiUseCaseAssignment.create({
    data: {
      useCase: "recommendation",
      providerId: local.id,
      modelId: llama.id,
    },
  });
}

async function exportBundle() {
  const res = await exportGET();
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  invalidateProviderCache();
  invalidateGuardrailSettings();
  asAdmin();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("/api/admin/ai-config", () => {
  it("refuses a non-admin", async () => {
    asTeacher();
    expect((await exportGET()).status).toBe(403);
    expect((await importPOST(importReq({}))).status).toBe(403);
  });

  it("exports everything, keyed by name, with the API key in plaintext", async () => {
    await seedSite();
    const res = await exportGET();
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="ai-config-/,
    );
    const bundle = await res.json();

    expect(bundle.format).toBe("talent-ai-config");
    const dev = bundle.providers.find(
      (p: { name: string }) => p.name === "Dev OpenAI",
    );
    expect(dev).toMatchObject({
      providerType: "openai",
      apiKey: "sk-dev-secret",
      timeoutMs: 30_000,
      models: [{ modelId: "gpt-5.1", serviceTier: "flex" }],
    });
    expect(dev).not.toHaveProperty("id");
    expect(bundle.assignments.pdf_description).toEqual({
      providerName: "Dev OpenAI",
      providerType: "openai",
      modelId: "gpt-5.1",
      serviceTier: "flex",
      thinkingLevel: "high",
    });
    expect(bundle.assignments.moderation).toBeNull();
    expect(bundle.assistants).toHaveLength(ASSISTANT_AUDIENCES.length);
    expect(bundle.guardrails).toHaveProperty("jailbreakMode");
  });

  it("round-trips onto an empty site", async () => {
    await seedSite();
    await saveAssistantSettings("student", { enabled: true, turnsPerHour: 12 });
    const bundle = await exportBundle();
    await resetDb();

    const res = await importPOST(
      importReq(bundle, { assistants: true, guardrails: true }),
    );
    expect(res.status).toBe(200);

    const providers = await prisma.aiProvider.findMany({
      include: { models: true },
    });
    expect(providers).toHaveLength(2);
    const dev = providers.find((p) => p.name === "Dev OpenAI")!;
    expect(decryptApiKey(dev.apiKeyEnc!, dev.apiKeyIv!, dev.apiKeyTag!)).toBe(
      "sk-dev-secret",
    );
    const pdf = await prisma.aiUseCaseAssignment.findUnique({
      where: { useCase: "pdf_description" },
      include: { model: true },
    });
    expect(pdf?.providerId).toBe(dev.id);
    expect(pdf?.model.modelId).toBe("gpt-5.1");
    expect(pdf?.thinkingLevel).toBe("high");
    const student = await prisma.assistantConfig.findUnique({
      where: { id: "student" },
    });
    expect(student).toMatchObject({ enabled: true, turnsPerHour: 12 });
  });

  it("imports only the selected providers and use cases", async () => {
    await seedSite();
    const bundle = await exportBundle();
    await prisma.aiProvider.deleteMany();

    const res = await importPOST(
      importReq(bundle, {
        providers: ["local:Local"],
        useCases: ["recommendation", "pdf_description"],
      }),
    );
    const { report } = await res.json();

    const providers = await prisma.aiProvider.findMany();
    expect(providers.map((p) => p.name)).toEqual(["Local"]);
    expect(await prisma.aiUseCaseAssignment.count()).toBe(1);
    // Its provider was left out and does not exist here, so it cannot land.
    expect(
      report.useCases.find(
        (u: { useCase: string }) => u.useCase === "pdf_description",
      ).result,
    ).toMatch(/skipped/);
    // Not selected at all → never touched.
    expect(
      report.useCases.some(
        (u: { useCase: string }) => u.useCase === "moderation",
      ),
    ).toBe(false);
  });

  it("merges into a matching provider without duplicating it or dropping its key", async () => {
    await seedSite();
    const bundle = await exportBundle();
    for (const p of bundle.providers) p.apiKey = null;
    bundle.providers[0].models.push({ modelId: "gpt-5.1-mini" });

    const res = await importPOST(importReq(bundle));
    expect(res.status).toBe(200);

    const providers = await prisma.aiProvider.findMany({
      include: { models: true },
    });
    expect(providers).toHaveLength(2);
    const dev = providers.find((p) => p.name === "Dev OpenAI")!;
    expect(dev.models.map((m) => m.modelId).sort()).toEqual([
      "gpt-5.1",
      "gpt-5.1-mini",
    ]);
    expect(decryptApiKey(dev.apiKeyEnc!, dev.apiKeyIv!, dev.apiKeyTag!)).toBe(
      "sk-dev-secret",
    );
  });

  it("overwrites everything when replaceExisting is set", async () => {
    await seedSite();
    const bundle = await exportBundle();
    await prisma.aiProvider.create({
      data: { name: "Prod only", providerType: "openai" },
    });

    const res = await importPOST(
      importReq(bundle, {
        providers: ["openai:Dev OpenAI"],
        useCases: ["pdf_description"],
        replaceExisting: true,
      }),
    );
    const { report } = await res.json();

    expect(report.removedProviders).toBe(3);
    const providers = await prisma.aiProvider.findMany();
    expect(providers.map((p) => p.name)).toEqual(["Dev OpenAI"]);
    const assignments = await prisma.aiUseCaseAssignment.findMany();
    expect(assignments.map((a) => a.useCase)).toEqual(["pdf_description"]);
  });

  it("rejects a file that is not an export, changing nothing", async () => {
    await seedSite();
    const res = await importPOST(
      importReq(
        { format: "something-else", providers: [] },
        {
          replaceExisting: true,
        },
      ),
    );
    expect(res.status).toBe(400);
    expect(await prisma.aiProvider.count()).toBe(2);
  });
});
