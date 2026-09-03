import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, PUT } from "@/app/api/admin/ai-assignments/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateProviderCache, resolveProvider } from "@/lib/ai-provider";
import { resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const asAdmin = () =>
  mockAuth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
const asTeacher = () =>
  mockAuth.mockResolvedValue({ user: { id: "t-1", role: "TEACHER" } } as never);

const BASE = "http://localhost/api/admin/ai-assignments";

function putReq(assignments: unknown) {
  return new NextRequest(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignments }),
  });
}

async function seedModel() {
  const provider = await prisma.aiProvider.create({
    data: { name: "Test Provider", providerType: "openai" },
  });
  const model = await prisma.aiModel.create({
    data: { providerId: provider.id, modelId: "gpt-5.1" },
  });
  return { provider, model };
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  invalidateProviderCache();
  asAdmin();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("/api/admin/ai-assignments", () => {
  it("refuses both verbs to a non-admin", async () => {
    asTeacher();
    expect((await GET()).status).toBe(403);
    expect((await PUT(putReq({}))).status).toBe(403);
  });

  it("stores the thinking level on the assignment, not the model", async () => {
    const { provider, model } = await seedModel();

    const res = await PUT(
      putReq({
        pdf_description: {
          providerId: provider.id,
          modelId: model.id,
          thinkingLevel: "high",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).results.pdf_description).toBe("saved");

    const saved = await prisma.aiUseCaseAssignment.findUnique({
      where: { useCase: "pdf_description" },
    });
    expect(saved?.thinkingLevel).toBe("high");
    expect(
      (await prisma.aiModel.findUnique({ where: { id: model.id } }))
        ?.thinkingLevel,
    ).toBeNull();
    expect((await resolveProvider("pdf_description"))?.thinkingLevel).toBe(
      "high",
    );
  });

  it("lets one model run at a different level per use case", async () => {
    const { provider, model } = await seedModel();
    await PUT(
      putReq({
        quiz_extraction: {
          providerId: provider.id,
          modelId: model.id,
          thinkingLevel: "low",
        },
        student_assistant: {
          providerId: provider.id,
          modelId: model.id,
          thinkingLevel: "high",
        },
      }),
    );

    expect((await resolveProvider("quiz_extraction"))?.thinkingLevel).toBe(
      "low",
    );
    expect((await resolveProvider("student_assistant"))?.thinkingLevel).toBe(
      "high",
    );
  });

  it("clears the level when an empty one is sent", async () => {
    const { provider, model } = await seedModel();
    await PUT(
      putReq({
        recommendation: {
          providerId: provider.id,
          modelId: model.id,
          thinkingLevel: "high",
        },
      }),
    );
    invalidateProviderCache();

    await PUT(
      putReq({
        recommendation: {
          providerId: provider.id,
          modelId: model.id,
          thinkingLevel: "",
        },
      }),
    );
    expect((await resolveProvider("recommendation"))?.thinkingLevel).toBeNull();
  });

  it("skips a use case whose thinking level is not a known level", async () => {
    const { provider, model } = await seedModel();
    const res = await PUT(
      putReq({
        recommendation: {
          providerId: provider.id,
          modelId: model.id,
          thinkingLevel: "ludicrous",
        },
      }),
    );

    expect((await res.json()).results.recommendation).toMatch(
      /thinking level must be one of/,
    );
    expect(
      await prisma.aiUseCaseAssignment.findUnique({
        where: { useCase: "recommendation" },
      }),
    ).toBeNull();
  });

  it("carries a pre-move per-model level onto its assignments and clears it", async () => {
    const { provider, model } = await seedModel();
    await prisma.aiModel.update({
      where: { id: model.id },
      data: { thinkingLevel: "medium" },
    });
    await prisma.aiUseCaseAssignment.create({
      data: {
        useCase: "pdf_description",
        providerId: provider.id,
        modelId: model.id,
      },
    });

    const body = await (await GET()).json();
    expect(body.assignments.pdf_description.thinkingLevel).toBe("medium");

    expect(
      (
        await prisma.aiUseCaseAssignment.findUnique({
          where: { useCase: "pdf_description" },
        })
      )?.thinkingLevel,
    ).toBe("medium");
    // Cleared, so the carry-over runs once and never resurrects a level the
    // admin later unsets.
    expect(
      (await prisma.aiModel.findUnique({ where: { id: model.id } }))
        ?.thinkingLevel,
    ).toBeNull();
  });

  it("leaves an explicit per-use-case level alone when carrying a legacy one over", async () => {
    const { provider, model } = await seedModel();
    await prisma.aiModel.update({
      where: { id: model.id },
      data: { thinkingLevel: "medium" },
    });
    await prisma.aiUseCaseAssignment.create({
      data: {
        useCase: "pdf_description",
        providerId: provider.id,
        modelId: model.id,
        thinkingLevel: "none",
      },
    });

    const body = await (await GET()).json();
    expect(body.assignments.pdf_description.thinkingLevel).toBe("none");
    expect(
      (await prisma.aiModel.findUnique({ where: { id: model.id } }))
        ?.thinkingLevel,
    ).toBeNull();
  });
});
