import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const moderationCreate = vi.fn();
const chatStream = vi.fn();

vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...actual,
    resolveProvider: vi.fn(),
    createOpenAIClient: vi.fn(async () => ({
      moderations: { create: moderationCreate },
    })),
  };
});

vi.mock("@/lib/ai-streaming", () => ({
  streamChatCompletion: (...args: unknown[]) => chatStream(...args),
  streamOptionsFor: () => ({}),
  transportFor: () => "chat_completions",
}));

import { POST } from "@/app/api/admin/ai-assignments/test/route";
import { auth } from "@/lib/auth";
import { resolveProvider, USE_CASES } from "@/lib/ai-provider";

const mockAuth = vi.mocked(auth);
const mockResolve = vi.mocked(resolveProvider);

const PROVIDER = {
  providerType: "openai",
  model: "gpt-5.1",
  serviceTier: null,
  thinkingLevel: null,
};

function req(body: unknown) {
  return new Request("http://localhost/api/admin/ai-assignments/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "a-1", role: "ADMIN" } } as never);
  mockResolve.mockResolvedValue(PROVIDER as never);
  chatStream.mockResolvedValue({ text: "ok", metrics: { totalMs: 5 } });
  moderationCreate.mockResolvedValue({ results: [{ flagged: false }] });
});

describe("/api/admin/ai-assignments/test", () => {
  it("refuses a non-admin", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "t-1", role: "TEACHER" },
    } as never);
    expect((await POST(req({ useCase: "moderation" }))).status).toBe(403);
  });

  // The list of testable use cases used to be a hand-copied duplicate, and it
  // went stale: guardrail and moderation assignments were rejected as invalid.
  it("accepts every assignable use case", async () => {
    for (const useCase of USE_CASES) {
      const res = await POST(req({ useCase }));
      expect(res.status, useCase).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ success: true });
    }
  });

  it("rejects an unknown use case with the full list", async () => {
    const res = await POST(req({ useCase: "not_a_use_case" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    for (const useCase of USE_CASES) expect(body.error).toContain(useCase);
  });

  it("tests a moderation assignment on the moderations endpoint", async () => {
    const res = await POST(req({ useCase: "moderation" }));

    expect(chatStream).not.toHaveBeenCalled();
    expect(moderationCreate).toHaveBeenCalledWith({
      model: "gpt-5.1",
      input: expect.any(String),
    });
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      reply: expect.stringContaining("not flagged"),
    });
  });

  it("uses a chat completion for the guardrail classifiers", async () => {
    await POST(req({ useCase: "guardrail_offtopic" }));

    expect(moderationCreate).not.toHaveBeenCalled();
    expect(chatStream).toHaveBeenCalled();
  });

  // The provider answers a raw `code 2019` that names neither the fix nor the
  // fact that moderation silently fails open at runtime.
  it("explains an unsupported moderations endpoint as a provider change", async () => {
    mockResolve.mockResolvedValue({
      ...PROVIDER,
      model: "omni-moderation-latest",
    } as never);
    moderationCreate.mockRejectedValue(
      Object.assign(
        new Error(
          '400 [{"code":2019,"message":"Compatibility endpoint: moderations is not supported."}]',
        ),
        { status: 400 },
      ),
    );

    const res = await POST(req({ useCase: "moderation" }));
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.error).toContain("does not implement the /v1/moderations");
    expect(body.error).toContain("omni-moderation-latest");
    expect(body.error).toContain("code");
  });

  it("explains a chat model on the moderation slot as a model change", async () => {
    moderationCreate.mockRejectedValue(
      Object.assign(new Error("400 model_not_supported"), { status: 400 }),
    );

    const res = await POST(req({ useCase: "moderation" }));
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.error).toContain("gpt-5.1 is a chat model");
  });

  it("passes an ordinary moderation failure through unembellished", async () => {
    mockResolve.mockResolvedValue({
      ...PROVIDER,
      model: "omni-moderation-latest",
    } as never);
    moderationCreate.mockRejectedValue(new Error("429 Rate limit reached"));

    const body = await (await POST(req({ useCase: "moderation" }))).json();

    expect(body).toMatchObject({
      success: false,
      error: "429 Rate limit reached",
    });
  });

  it("reports an unassigned use case instead of calling out", async () => {
    mockResolve.mockResolvedValue(null);
    const res = await POST(req({ useCase: "guardrail_jailbreak" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: false });
    expect(chatStream).not.toHaveBeenCalled();
  });
});
