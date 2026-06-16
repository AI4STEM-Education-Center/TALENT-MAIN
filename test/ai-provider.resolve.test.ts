import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { resolveProvider, invalidateProviderCache, DEFAULT_AI_TIMEOUT_MS } from "@/lib/ai-provider";
import { encryptApiKey } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./db";

async function seedAssignment(
  opts: {
    useCase?: string;
    isActive?: boolean;
    apiKey?: string | null;
    serviceTier?: string | null;
    providerType?: string;
    baseUrl?: string | null;
    cfAigByokAlias?: string | null;
    timeoutMs?: number | null;
  } = {}
) {
  const enc = opts.apiKey ? encryptApiKey(opts.apiKey) : null;
  const provider = await prisma.aiProvider.create({
    data: {
      name: "Test Provider",
      providerType: opts.providerType ?? "openai",
      baseUrl: opts.baseUrl ?? null,
      isActive: opts.isActive ?? true,
      cfAigByokAlias: opts.cfAigByokAlias ?? null,
      timeoutMs: opts.timeoutMs ?? null,
      apiKeyEnc: enc?.encrypted ?? null,
      apiKeyIv: enc?.iv ?? null,
      apiKeyTag: enc?.tag ?? null,
    },
  });
  const model = await prisma.aiModel.create({
    data: { providerId: provider.id, modelId: "gpt-5.1", serviceTier: opts.serviceTier ?? null },
  });
  await prisma.aiUseCaseAssignment.create({
    data: { useCase: opts.useCase ?? "pdf_description", providerId: provider.id, modelId: model.id },
  });
  return { provider, model };
}

beforeEach(async () => {
  await resetDb();
  invalidateProviderCache();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("resolveProvider", () => {
  it("returns null when no assignment exists for the use case", async () => {
    expect(await resolveProvider("pdf_description")).toBeNull();
  });

  it("resolves and decrypts the API key for an active provider", async () => {
    await seedAssignment({ apiKey: "sk-secret-123", serviceTier: "flex" });
    const resolved = await resolveProvider("pdf_description");
    expect(resolved).toMatchObject({
      providerType: "openai",
      model: "gpt-5.1",
      serviceTier: "flex",
      apiKey: "sk-secret-123",
    });
  });

  it("falls back to DEFAULT_AI_TIMEOUT_MS when the provider has no override", async () => {
    await seedAssignment({ apiKey: "sk-x" });
    const resolved = await resolveProvider("pdf_description");
    expect(resolved?.timeoutMs).toBe(DEFAULT_AI_TIMEOUT_MS);
  });

  it("uses the provider's timeoutMs override when set", async () => {
    await seedAssignment({ apiKey: "sk-x", timeoutMs: 30_000 });
    const resolved = await resolveProvider("pdf_description");
    expect(resolved?.timeoutMs).toBe(30_000);
  });

  it("returns null when the provider is inactive", async () => {
    await seedAssignment({ isActive: false, apiKey: "sk-x" });
    expect(await resolveProvider("pdf_description")).toBeNull();
  });

  it("passes through the cloudflare BYOK alias", async () => {
    await seedAssignment({
      providerType: "cloudflare",
      baseUrl: "https://gateway.example/v1",
      apiKey: "cf-token",
      cfAigByokAlias: "my-alias",
    });
    const resolved = await resolveProvider("pdf_description");
    expect(resolved?.cfAigByokAlias).toBe("my-alias");
    expect(resolved?.baseUrl).toBe("https://gateway.example/v1");
  });

  it("caches the result for 60s, then re-reads after expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);

    const { provider } = await seedAssignment({ apiKey: "sk-x" });
    expect(await resolveProvider("pdf_description")).not.toBeNull();

    // Deactivate in the DB — but within the TTL the cached value is still served.
    await prisma.aiProvider.update({ where: { id: provider.id }, data: { isActive: false } });
    vi.setSystemTime(30_000);
    expect(await resolveProvider("pdf_description")).not.toBeNull();

    // After the 60s TTL it re-queries and now sees the inactive provider.
    vi.setSystemTime(61_000);
    expect(await resolveProvider("pdf_description")).toBeNull();
  });

  it("invalidateProviderCache forces an immediate re-read", async () => {
    const { provider } = await seedAssignment({ apiKey: "sk-x" });
    expect(await resolveProvider("pdf_description")).not.toBeNull();

    await prisma.aiProvider.update({ where: { id: provider.id }, data: { isActive: false } });
    invalidateProviderCache("pdf_description");
    expect(await resolveProvider("pdf_description")).toBeNull();
  });
});
