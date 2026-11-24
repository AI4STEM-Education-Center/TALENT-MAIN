import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const decisionsCreate = vi.fn();

vi.mock("@/lib/ai-decisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-decisions")>();
  return {
    ...actual,
    createDecisions: (...args: unknown[]) => decisionsCreate(...args),
  };
});

vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return {
    ...actual,
    resolveProvider: vi.fn(),
  };
});

import { POST } from "@/app/api/admin/ai-assignments/test/route";
import { auth } from "@/lib/auth";
import { resolveProvider } from "@/lib/ai-provider";
import { DecisionsApiError } from "@/lib/ai-decisions";

const mockAuth = vi.mocked(auth);
const mockResolve = vi.mocked(resolveProvider);

const DECISIONS_PROVIDER = {
  providerType: "openai",
  apiKey: "sk-test",
  baseUrl: null,
  model: "gpt-6-luna",
  serviceTier: null,
  thinkingLevel: null,
};

function makeReq(body: unknown) {
  return new Request("http://localhost/api/admin/ai-assignments/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
  mockResolve.mockResolvedValue(DECISIONS_PROVIDER as never);
  decisionsCreate.mockResolvedValue({
    id: "dec_smoke_1",
    model: "gpt-6-luna",
    answers: [
      {
        name: "check2_probe",
        type: "choice",
        choice: "sound",
        confidence: 0.99,
        probabilities: [
          { value: "sound", probability: 0.99 },
          { value: "neither", probability: 0.01 },
        ],
      },
    ],
    latencyMs: 25,
    raw: {},
  });
});

describe("/api/admin/ai-assignments/test (Decisions API)", () => {
  it("routes wrong_answer_coach_classify to POST /v1/decisions and returns choice + confidence", async () => {
    const res = await POST(makeReq({ useCase: "wrong_answer_coach_classify" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      model: "gpt-6-luna",
    });
    expect(body.reply).toContain("Decisions endpoint (/v1/decisions) answered");
    expect(body.reply).toContain("99%");
    expect(decisionsCreate).toHaveBeenCalledTimes(1);
  });

  it("explains an unsupported /v1/decisions endpoint clearly", async () => {
    decisionsCreate.mockRejectedValue(
      new DecisionsApiError("404 Not Found", { status: 404 }),
    );
    const res = await POST(makeReq({ useCase: "wrong_answer_coach_classify" }));
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("/v1/decisions");
    expect(body.error).toContain("gpt-6-luna");
  });

  it("explains a chat model assigned to the Decisions API slot", async () => {
    mockResolve.mockResolvedValue({
      ...DECISIONS_PROVIDER,
      model: "gpt-5.1",
    } as never);
    decisionsCreate.mockRejectedValue(
      new DecisionsApiError("model_not_supported", {
        status: 400,
        code: "model_not_supported",
      }),
    );
    const res = await POST(makeReq({ useCase: "wrong_answer_coach_classify" }));
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("gpt-5.1");
    expect(body.error).toContain("gpt-6-luna");
  });

  it("rejects non-admin callers with 403", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "s-1", role: "STUDENT" },
    } as never);
    const res = await POST(makeReq({ useCase: "wrong_answer_coach_classify" }));
    expect(res.status).toBe(403);
  });
});
