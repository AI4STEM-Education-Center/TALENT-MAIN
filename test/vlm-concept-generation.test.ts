import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-provider")>()),
  resolveProvider: vi.fn().mockResolvedValue({
    providerType: "local",
    model: "test-model",
    apiSurface: "chat_completions",
    baseUrl: null,
    serviceTier: null,
    thinkingLevel: null,
  }),
  createOpenAIClient: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/ai-streaming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-streaming")>()),
  streamJsonCompletion: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({
  getS3Config: () => ({ bucket: "test" }),
  resolveModelImageUrl: vi
    .fn()
    .mockResolvedValue("https://example.test/page.png"),
}));
vi.mock("@/lib/guardrail-settings", () => ({
  getGuardrailSettings: vi.fn().mockResolvedValue({}),
  moderationEnabledFor: () => false,
}));
vi.mock("@/lib/guardrail-runner", () => ({ auditText: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { streamJsonCompletion } from "@/lib/ai-streaming";
import { processMaterial } from "@/lib/vlm-engine";
import { getActiveConceptLabels } from "@/lib/concept-catalog";

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.learningMaterial.deleteMany();
  await prisma.concept.deleteMany();
});

it("generates from an empty catalog, registers page and summary labels, and offers them on later runs", async () => {
  const metrics = {
    model: "test-model",
    ttftMs: 1,
    totalMs: 2,
    completionTokens: 3,
    tokensEstimated: false,
    generationMs: 1,
    tokensPerSec: 3000,
  };
  const completion = vi.mocked(streamJsonCompletion);
  completion
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [],
      finishReason: "stop",
      value: {
        needed: true,
        key_concept: "Wave interference",
        description: "Waves combine by superposition.",
      },
      metrics,
    })
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [],
      finishReason: "stop",
      value: {
        key_concept: ["Wave interference", "Superposition"],
        description: "Interference and superposition.",
      },
      metrics,
    });
  const material = await prisma.learningMaterial.create({
    data: {
      originalName: "waves.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      storageKey: "waves.pdf",
      bucket: "test",
      totalPages: 1,
      pages: { create: { pageNumber: 1, storageKey: "waves-1.png" } },
    },
  });
  await processMaterial(material.id);
  const saved = await prisma.learningMaterial.findUniqueOrThrow({
    where: { id: material.id },
    include: { pages: true },
  });
  expect(saved.processingStatus).toBe("SUCCESS");
  expect(saved.pages[0].keyConcept).toBe("Wave interference");
  expect(JSON.parse(saved.batchKeyConcepts)).toEqual([
    "Wave interference",
    "Superposition",
  ]);
  expect(await getActiveConceptLabels()).toEqual(
    expect.arrayContaining(["Wave interference", "Superposition"]),
  );
  // Tier 2 already sees the concept discovered during Tier 1.
  expect(JSON.stringify(completion.mock.calls[1][1].messages)).toContain(
    "- Wave interference",
  );

  completion.mockResolvedValueOnce({
    text: "",
    toolCalls: [],
    finishReason: "stop",
    value: {
      key_concept: ["Superposition"],
      description: "Summary regenerated.",
    },
    metrics,
  });
  await processMaterial(material.id);
  expect(JSON.stringify(completion.mock.calls[2][1].messages)).toContain(
    "- Superposition",
  );
  expect(await prisma.concept.count()).toBe(2);
});
