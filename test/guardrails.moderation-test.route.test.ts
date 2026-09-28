import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const moderationCreate = vi.fn();

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

import { POST } from "@/app/api/admin/guardrails/moderation-test/route";
import { auth } from "@/lib/auth";
import { resolveProvider } from "@/lib/ai-provider";

const mockAuth = vi.mocked(auth);
const mockResolve = vi.mocked(resolveProvider);

const PROVIDER = {
  providerType: "cloudflare",
  model: "omni-moderation-latest",
  apiKey: "cf-token",
};

function req(body: unknown) {
  return new Request("http://localhost/api/admin/guardrails/moderation-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "a-1", role: "ADMIN" } } as never);
  mockResolve.mockResolvedValue(PROVIDER as never);
});

describe("POST /api/admin/guardrails/moderation-test", () => {
  it("refuses a non-admin", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "t-1", role: "TEACHER" },
    } as never);
    expect((await POST(req({ text: "hello" }))).status).toBe(403);
    expect(moderationCreate).not.toHaveBeenCalled();
  });

  it("rejects empty text", async () => {
    expect((await POST(req({ text: "   " }))).status).toBe(400);
  });

  it("reports the flagged categories and the highest scores across chunks", async () => {
    moderationCreate.mockResolvedValue({
      results: [
        {
          flagged: true,
          categories: { violence: true, harassment: false },
          category_scores: { violence: 0.91, harassment: 0.2, hate: 0.01 },
        },
        {
          flagged: false,
          categories: { violence: false, harassment: false },
          category_scores: { violence: 0.1, harassment: 0.4, hate: 0.02 },
        },
      ],
    });

    const body = await (await POST(req({ text: "I will hurt you" }))).json();

    expect(moderationCreate).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: ["I will hurt you"],
    });
    expect(body.success).toBe(true);
    expect(body.flagged).toBe(true);
    expect(body.categories).toEqual(["violence"]);
    expect(body.scores.slice(0, 2)).toEqual([
      { category: "violence", score: 0.91 },
      { category: "harassment", score: 0.4 },
    ]);
  });

  it("reports clean content as not flagged", async () => {
    moderationCreate.mockResolvedValue({
      results: [{ flagged: false, categories: {}, category_scores: {} }],
    });
    const body = await (await POST(req({ text: "hello" }))).json();
    expect(body).toMatchObject({ success: true, flagged: false });
  });

  it("says so when moderation is not assigned", async () => {
    mockResolve.mockResolvedValue(null as never);
    const body = await (await POST(req({ text: "hello" }))).json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("not assigned");
  });

  it("names a provider without a moderations endpoint instead of failing open", async () => {
    moderationCreate.mockRejectedValue(
      new Error("Compatibility endpoint: moderations is not supported."),
    );
    const body = await (await POST(req({ text: "hello" }))).json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("does not implement /v1/moderations");
  });
});
