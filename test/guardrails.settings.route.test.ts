import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, PUT } from "@/app/api/admin/guardrails/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getGuardrailSettings,
  invalidateGuardrailSettings,
  defaultGuardrailSettings,
} from "@/lib/guardrail-settings";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const asAdmin = () =>
  mockAuth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
const asTeacher = () =>
  mockAuth.mockResolvedValue({ user: { id: "t-1", role: "TEACHER" } } as never);

const BASE = "http://localhost/api/admin/guardrails";

function putReq(body: unknown) {
  return new Request(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetDb();
  invalidateGuardrailSettings();
  asAdmin();
});

describe("GET /api/admin/guardrails", () => {
  it("returns the shipped defaults when no row exists", async () => {
    const body = await (await GET()).json();
    expect(body.settings).toEqual(defaultGuardrailSettings());
  });

  it("returns the surface catalog and bounds the form renders from", async () => {
    const body = await (await GET()).json();
    expect(body.surfaces.length).toBeGreaterThan(0);
    expect(body.surfaces[0]).toHaveProperty("key");
    expect(body.surfaces[0]).toHaveProperty("label");
    expect(body.thresholdBounds).toEqual({ min: 0, max: 1 });
    expect(body.defaultTopicDescription).toContain("STEM");
  });

  it("is admin-only", async () => {
    asTeacher();
    expect((await GET()).status).toBe(403);
    mockAuth.mockResolvedValue(null as never);
    expect((await GET()).status).toBe(403);
  });
});

describe("PUT /api/admin/guardrails", () => {
  it("saves settings and reads them back", async () => {
    const res = await PUT(
      putReq({
        moderationEnabled: false,
        jailbreakMode: "BLOCK",
        offTopicMode: "FLAG",
        jailbreakThreshold: 0.8,
        offTopicThreshold: 0.6,
        topicDescription: "Only physics",
        failOpen: false,
        disabledSurfaces: ["assistant_reply"],
      }),
    );
    expect(res.status).toBe(200);

    invalidateGuardrailSettings();
    const stored = await getGuardrailSettings();
    expect(stored).toEqual({
      moderationEnabled: false,
      jailbreakMode: "BLOCK",
      offTopicMode: "FLAG",
      jailbreakThreshold: 0.8,
      offTopicThreshold: 0.6,
      topicDescription: "Only physics",
      failOpen: false,
      disabledSurfaces: ["assistant_reply"],
    });
  });

  it("upserts rather than creating a second row", async () => {
    await PUT(putReq({ jailbreakMode: "BLOCK" }));
    await PUT(putReq({ jailbreakMode: "OFF" }));

    expect(await prisma.guardrailConfig.count()).toBe(1);
    invalidateGuardrailSettings();
    expect((await getGuardrailSettings()).jailbreakMode).toBe("OFF");
  });

  it("normalizes hostile input server-side rather than trusting the form", async () => {
    const body = await (
      await PUT(
        putReq({
          jailbreakMode: "ALLOW_EVERYTHING",
          jailbreakThreshold: 99,
          disabledSurfaces: ["nope"],
          topicDescription: "y".repeat(9_000),
        }),
      )
    ).json();

    expect(body.settings.jailbreakMode).toBe("FLAG");
    expect(body.settings.jailbreakThreshold).toBe(1);
    expect(body.settings.disabledSurfaces).toEqual([]);
    expect(body.settings.topicDescription).toHaveLength(2_000);
  });

  it("rejects a malformed body", async () => {
    expect((await PUT(putReq("not json"))).status).toBe(400);
  });

  it("is admin-only", async () => {
    asTeacher();
    expect((await PUT(putReq({ jailbreakMode: "OFF" }))).status).toBe(403);
    expect(await prisma.guardrailConfig.count()).toBe(0);
  });

  it("saving invalidates the cache, so the next read is not stale", async () => {
    // Warm the cache with the defaults.
    expect((await getGuardrailSettings()).jailbreakMode).toBe("FLAG");
    // No manual invalidation here — saveGuardrailSettings must do it.
    await PUT(putReq({ jailbreakMode: "BLOCK" }));
    expect((await getGuardrailSettings()).jailbreakMode).toBe("BLOCK");
  });
});

describe("GET /api/admin/guardrails — model read-out", () => {
  async function assign(
    useCase: string,
    modelId: string,
    thinkingLevel: string | null = null,
  ) {
    const provider =
      (await prisma.aiProvider.findFirst({ where: { name: "Test OpenAI" } })) ??
      (await prisma.aiProvider.create({
        data: { name: "Test OpenAI", providerType: "openai", isActive: true },
      }));
    const model =
      (await prisma.aiModel.findFirst({
        where: { providerId: provider.id, modelId },
      })) ??
      (await prisma.aiModel.create({
        data: { providerId: provider.id, modelId },
      }));
    await prisma.aiUseCaseAssignment.create({
      data: {
        useCase,
        providerId: provider.id,
        modelId: model.id,
        thinkingLevel,
      },
    });
    return { provider, model };
  }

  it("reports every guardrail check as unassigned when nothing is set up", async () => {
    const body = await (await GET()).json();
    expect(body.models.moderation).toBeNull();
    expect(body.models.guardrail_jailbreak).toBeNull();
    expect(body.models.guardrail_offtopic).toBeNull();
    expect(body.sharesOneCall).toBe(false);
  });

  it("names the model each check runs on", async () => {
    await assign("guardrail_jailbreak", "gpt-5-mini");

    const body = await (await GET()).json();
    expect(body.models.guardrail_jailbreak.label).toBe(
      "Test OpenAI — gpt-5-mini",
    );
    expect(body.models.guardrail_jailbreak.providerActive).toBe(true);
    expect(body.models.guardrail_offtopic).toBeNull();
  });

  // Moderation fails open, so an assignment that can never work is invisible
  // at runtime — the panel has to say so from the assignment alone.
  it("warns that a Cloudflare provider has no moderations endpoint", async () => {
    const provider = await prisma.aiProvider.create({
      data: { name: "cf", providerType: "cloudflare", isActive: true },
    });
    const model = await prisma.aiModel.create({
      data: {
        providerId: provider.id,
        modelId: "openai/omni-moderation-latest",
      },
    });
    await prisma.aiUseCaseAssignment.create({
      data: {
        useCase: "moderation",
        providerId: provider.id,
        modelId: model.id,
      },
    });

    const body = await (await GET()).json();
    expect(body.models.moderation.warning).toContain("/v1/moderations");
    expect(body.models.moderation.warning).toContain("Cloudflare");
  });

  it("warns when a chat model is assigned to moderation", async () => {
    await assign("moderation", "gpt-5.1");

    expect((await (await GET()).json()).models.moderation.warning).toContain(
      "chat model",
    );
  });

  it("has no warning for a moderation model on a provider that serves it", async () => {
    await assign("moderation", "omni-moderation-latest");

    expect((await (await GET()).json()).models.moderation.warning).toBeNull();
  });

  // Only moderation uses /v1/moderations; the LLM checks are chat calls, so a
  // chat model there is exactly right.
  it("never warns about the models the LLM checks run on", async () => {
    await assign("guardrail_jailbreak", "gpt-5-mini");

    expect(
      (await (await GET()).json()).models.guardrail_jailbreak.warning,
    ).toBeNull();
  });

  it("reports sharesOneCall when both checks land on the same model", async () => {
    await assign("guardrail_jailbreak", "gpt-5-mini");
    await assign("guardrail_offtopic", "gpt-5-mini");

    expect((await (await GET()).json()).sharesOneCall).toBe(true);
  });

  it("does not report sharesOneCall for different models", async () => {
    await assign("guardrail_jailbreak", "gpt-5-mini");
    await assign("guardrail_offtopic", "gpt-5-nano");

    expect((await (await GET()).json()).sharesOneCall).toBe(false);
  });

  it("does not report sharesOneCall when only the reasoning effort differs", async () => {
    // Same model, different reasoning effort is a different request, so the two
    // questions cannot ride in one call — matching planCheckCalls().
    await assign("guardrail_jailbreak", "gpt-5-mini", "high");
    await assign("guardrail_offtopic", "gpt-5-mini", null);

    expect((await (await GET()).json()).sharesOneCall).toBe(false);
  });

  it("flags a check whose provider has been switched off", async () => {
    const { provider } = await assign("guardrail_jailbreak", "gpt-5-mini");
    await prisma.aiProvider.update({
      where: { id: provider.id },
      data: { isActive: false },
    });

    expect(
      (await (await GET()).json()).models.guardrail_jailbreak.providerActive,
    ).toBe(false);
  });
});
