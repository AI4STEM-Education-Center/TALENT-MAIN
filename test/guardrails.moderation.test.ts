import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedProvider } from "@/lib/ai-provider";

// The moderation half of the guardrail layer talks to a provider and the system
// log, so both are mocked here. The pure fencing/shaping helpers are covered in
// src/lib/guardrail-fence.test.ts.

const resolveProvider = vi.fn();
const createOpenAIClient = vi.fn();
const logSystemEvent = vi.fn(async (_event: unknown) => {});

vi.mock("@/lib/ai-provider", () => ({
  resolveProvider: (...args: unknown[]) => resolveProvider(...args),
  createOpenAIClient: (...args: unknown[]) => createOpenAIClient(...args),
}));

vi.mock("@/lib/system-log", () => ({
  logSystemEvent: (event: unknown) => logSystemEvent(event),
}));

const { moderateText, moderateImages, moderateContent } = await import("@/lib/guardrails");

const PROVIDER: ResolvedProvider = {
  providerType: "openai",
  baseUrl: null,
  apiKey: "sk-test",
  model: "omni-moderation-latest",
  serviceTier: null,
  thinkingLevel: null,
  cfAigByokAlias: null,
  timeoutMs: 600_000,
  apiSurface: "responses",
};

/** The shape guardrails.ts sends to `client.moderations.create`. */
type ModerationCall = { model: string; input: unknown };

/** Install a fake moderation client and return the spy on `moderations.create`. */
function mockModeration(response: unknown) {
  // The parameter is declared so `create.mock.calls[0][0]` is typed — an
  // implementation with no arguments gives vitest an empty tuple to index.
  const create = vi.fn(async (_params: ModerationCall) => response);
  createOpenAIClient.mockResolvedValue({ moderations: { create } });
  return create;
}

const CLEAN = { results: [{ flagged: false, categories: { violence: false } }] };
const FLAGGED = { results: [{ flagged: true, categories: { violence: true, hate: false } }] };

beforeEach(() => {
  vi.clearAllMocks();
  resolveProvider.mockResolvedValue(PROVIDER);
});

describe("moderateText", () => {
  it("reports a clean verdict and marks the check as having run", async () => {
    const create = mockModeration(CLEAN);
    const verdict = await moderateText("what is kinetic energy?", { surface: "assistant_chat" });

    expect(verdict).toEqual({ checked: true, flagged: false, categories: [] });
    expect(create).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: ["what is kinetic energy?"],
    });
  });

  it("reports the flagged categories and writes a GUARDRAIL log row", async () => {
    mockModeration(FLAGGED);
    const verdict = await moderateText("...", { surface: "assistant_chat", userId: "u1", id: "c1" });

    expect(verdict).toEqual({ checked: true, flagged: true, categories: ["violence"] });
    expect(logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "GUARDRAIL",
        type: "MODERATION_FLAG",
        severity: "WARNING",
        userId: "u1",
        metadata: { surface: "assistant_chat", subjectId: "c1", categories: ["violence"] },
      })
    );
  });

  it("is off — not clean — when no provider is assigned", async () => {
    resolveProvider.mockResolvedValue(null);
    const create = mockModeration(CLEAN);

    expect(await moderateText("anything", { surface: "assistant_chat" })).toEqual({
      checked: false,
      flagged: false,
      categories: [],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("is off when a hosted provider has no API key", async () => {
    resolveProvider.mockResolvedValue({ ...PROVIDER, apiKey: null });
    const create = mockModeration(CLEAN);

    expect((await moderateText("x", { surface: "assistant_chat" })).checked).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("still runs for a local provider with no API key", async () => {
    resolveProvider.mockResolvedValue({ ...PROVIDER, providerType: "local", apiKey: null });
    const create = mockModeration(CLEAN);

    expect((await moderateText("x", { surface: "assistant_chat" })).checked).toBe(true);
    expect(create).toHaveBeenCalled();
  });

  it("FAILS OPEN when the endpoint throws, and logs at INFO", async () => {
    createOpenAIClient.mockResolvedValue({
      moderations: {
        create: vi.fn(async () => {
          throw new Error("404 Not Found");
        }),
      },
    });

    const verdict = await moderateText("x", { surface: "material_page", id: "m1" });

    expect(verdict).toEqual({ checked: false, flagged: false, categories: [] });
    expect(logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "GUARDRAIL",
        type: "MODERATION_UNAVAILABLE",
        severity: "INFO",
      })
    );
  });

  it("FAILS OPEN when provider resolution throws", async () => {
    resolveProvider.mockRejectedValue(new Error("database unavailable"));

    await expect(
      moderateText("x", { surface: "assistant_chat" })
    ).resolves.toEqual({ checked: false, flagged: false, categories: [] });
    expect(logSystemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "MODERATION_UNAVAILABLE" })
    );
  });

  it("does not call the endpoint for empty or whitespace-only text", async () => {
    const create = mockModeration(CLEAN);
    expect((await moderateText("   \n ", { surface: "assistant_chat" })).checked).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("chunks long text into an array rather than truncating it", async () => {
    const create = mockModeration(CLEAN);
    await moderateText("a".repeat(20_000), { surface: "quiz_extraction" });

    const input = create.mock.calls[0][0].input as string[];
    expect(input.length).toBeGreaterThan(1);
    expect(input.join("")).toHaveLength(20_000);
  });
});

describe("moderateImages", () => {
  it("sends each URL as an image_url part", async () => {
    const create = mockModeration(CLEAN);
    await moderateImages(["https://s3/page1.png", "https://s3/page2.png"], {
      surface: "quiz_extraction_page",
      id: "e1",
    });

    expect(create).toHaveBeenCalledWith({
      model: "omni-moderation-latest",
      input: [
        { type: "image_url", image_url: { url: "https://s3/page1.png" } },
        { type: "image_url", image_url: { url: "https://s3/page2.png" } },
      ],
    });
  });

  it("checks a whole document in ONE call, not one per page", async () => {
    const create = mockModeration(CLEAN);
    await moderateImages(
      Array.from({ length: 12 }, (_, i) => `https://s3/p${i}.png`),
      { surface: "quiz_extraction_page" }
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("checks every page of a document longer than one endpoint batch", async () => {
    const create = mockModeration(CLEAN);
    await moderateImages(
      Array.from({ length: 30 }, (_, i) => `https://s3/p${i}.png`),
      { surface: "quiz_extraction_page" }
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[0][0].input as unknown[])).toHaveLength(16);
    expect((create.mock.calls[1][0].input as unknown[])).toHaveLength(14);
  });

  it("does nothing when there are no usable URLs", async () => {
    const create = mockModeration(CLEAN);
    expect((await moderateImages(["", "  "], { surface: "material_page" })).checked).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("moderateContent", () => {
  it("moderates a plain string turn", async () => {
    const create = mockModeration(CLEAN);
    await moderateContent("hello", { surface: "assistant_chat" });
    expect(create).toHaveBeenCalledWith({ model: "omni-moderation-latest", input: ["hello"] });
  });

  it("checks text and images from one turn together in a single call", async () => {
    const create = mockModeration(CLEAN);
    await moderateContent(
      [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
      { surface: "assistant_chat", userId: "u1" }
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].input).toEqual([
      { type: "text", text: "look at this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("puts text first and checks every image on an image-heavy turn", async () => {
    const create = mockModeration(CLEAN);
    await moderateContent(
      [
        { type: "text", text: "question" },
        ...Array.from({ length: 20 }, (_, i) => ({
          type: "image_url" as const,
          image_url: { url: `data:image/png;base64,${i}` },
        })),
      ],
      { surface: "assistant_chat" }
    );

    const inputs = create.mock.calls.flatMap(
      (call) => call[0].input as Array<{ type: string; image_url?: { url: string } }>
    );
    expect(inputs[0]).toEqual({ type: "text", text: "question" });
    expect(inputs.filter((item) => item.type === "image_url")).toHaveLength(20);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("skips image parts with a blank URL", async () => {
    const create = mockModeration(CLEAN);
    await moderateContent(
      [
        { type: "text", text: "hi" },
        { type: "image_url", image_url: { url: "  " } },
      ],
      { surface: "assistant_chat" }
    );
    expect(create.mock.calls[0][0].input).toEqual([{ type: "text", text: "hi" }]);
  });

  it("does nothing for content with no usable parts", async () => {
    const create = mockModeration(CLEAN);
    expect((await moderateContent([], { surface: "assistant_chat" })).checked).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
