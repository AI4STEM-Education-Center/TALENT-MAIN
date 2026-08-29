import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultGuardrailSettings, type GuardrailSettings } from "@/lib/guardrail-settings";

// The runner is the only place that knows how the two halves combine, so this
// spec drives it with stubbed checks and asserts the combination rules:
// blocking, the fail-open/fail-closed switch, disabled surfaces, and the fact
// that the user-facing message never names the check that tripped.

const moderateText = vi.fn(async (..._a: unknown[]) => ({
  checked: true,
  flagged: false,
  categories: [] as string[],
}));
const moderateContent = vi.fn(async (..._a: unknown[]) => ({
  checked: true,
  flagged: false,
  categories: [] as string[],
}));
const checkContentSafety = vi.fn(async (..._a: unknown[]) => ({
  checked: true,
  blocked: false,
  reasons: [] as string[],
  result: null,
}));
const getGuardrailSettings = vi.fn(async () => defaultGuardrailSettings());
const recordGuardrailEvent = vi.fn(async (..._a: unknown[]): Promise<string | null> => "evt-1");

vi.mock("@/lib/guardrails", () => ({
  moderateText: (...a: unknown[]) => moderateText(...a),
  moderateContent: (...a: unknown[]) => moderateContent(...a),
  checkContentSafety: (...a: unknown[]) => checkContentSafety(...a),
}));

vi.mock("@/lib/guardrail-events", () => ({
  recordGuardrailEvent: (...a: unknown[]) => recordGuardrailEvent(...a),
}));

vi.mock("@/lib/guardrail-settings", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/guardrail-settings")>("@/lib/guardrail-settings");
  return { ...actual, getGuardrailSettings: () => getGuardrailSettings() };
});

const { guardText, guardChatTurn, auditText } = await import("@/lib/guardrail-runner");

function withSettings(overrides: Partial<GuardrailSettings>) {
  getGuardrailSettings.mockResolvedValue({ ...defaultGuardrailSettings(), ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  moderateText.mockResolvedValue({ checked: true, flagged: false, categories: [] });
  moderateContent.mockResolvedValue({ checked: true, flagged: false, categories: [] });
  checkContentSafety.mockResolvedValue({ checked: true, blocked: false, reasons: [], result: null });
  getGuardrailSettings.mockResolvedValue(defaultGuardrailSettings());
  recordGuardrailEvent.mockResolvedValue("evt-1");
});

describe("guardText", () => {
  it("allows clean content", async () => {
    expect(await guardText("hello", { surface: "question_authoring" })).toEqual({
      blocked: false,
      message: null,
      reasons: [],
      eventId: null,
    });
  });

  it("blocks on a moderation flag", async () => {
    moderateText.mockResolvedValue({ checked: true, flagged: true, categories: ["violence"] });

    const decision = await guardText("...", { surface: "question_authoring" });
    expect(decision.blocked).toBe(true);
    expect(decision.reasons).toEqual(["moderation:violence"]);
  });

  it("blocks on a safety BLOCK", async () => {
    checkContentSafety.mockResolvedValue({
      checked: true,
      blocked: true,
      reasons: ["jailbreak (0.91)"],
      result: null,
    });
    expect((await guardText("...", { surface: "question_authoring" })).blocked).toBe(true);
  });

  it("does NOT block on a FLAG-only trip — it only reports", async () => {
    checkContentSafety.mockResolvedValue({
      checked: true,
      blocked: false,
      reasons: ["jailbreak (0.91)"],
      result: null,
    });

    const decision = await guardText("...", { surface: "question_authoring" });
    expect(decision.blocked).toBe(false);
    expect(decision.reasons).toEqual(["jailbreak (0.91)"]);
  });

  it("never names the tripped check in the user-facing message", async () => {
    moderateText.mockResolvedValue({ checked: true, flagged: true, categories: ["self-harm"] });

    const decision = await guardText("...", { surface: "question_authoring" });
    expect(decision.message).not.toMatch(/self-harm|moderation|jailbreak/i);
    expect(decision.message).toContain("safety checks");
  });

  it("skips the moderation call when moderation is switched off", async () => {
    withSettings({ moderationEnabled: false });
    await guardText("x", { surface: "question_authoring" });
    expect(moderateText).not.toHaveBeenCalled();
    expect(checkContentSafety).toHaveBeenCalled();
  });

  it("skips moderation for a disabled surface and passes an inert policy", async () => {
    withSettings({ disabledSurfaces: ["question_authoring"], jailbreakMode: "BLOCK" });
    await guardText("x", { surface: "question_authoring" });

    expect(moderateText).not.toHaveBeenCalled();
    const options = checkContentSafety.mock.calls[0][2] as { policy: { jailbreakMode: string } };
    expect(options.policy.jailbreakMode).toBe("OFF");
  });

  it("passes the admin's topic description to the check", async () => {
    withSettings({ topicDescription: "Only chemistry" });
    await guardText("x", { surface: "assistant_chat" });

    const options = checkContentSafety.mock.calls[0][2] as { topicDescription: string };
    expect(options.topicDescription).toBe("Only chemistry");
  });
});

describe("failOpen", () => {
  it("allows content through when a check could not run (default)", async () => {
    checkContentSafety.mockResolvedValue({ checked: false, blocked: false, reasons: [], result: null });
    expect(
      (await guardText("x", { surface: "question_authoring" }, { requestPath: true })).blocked
    ).toBe(false);
  });

  it("REJECTS on a request path when failOpen is off and a check could not run", async () => {
    withSettings({ failOpen: false });
    checkContentSafety.mockResolvedValue({ checked: false, blocked: false, reasons: [], result: null });

    const decision = await guardText("x", { surface: "question_authoring" }, { requestPath: true });
    expect(decision.blocked).toBe(true);
    expect(decision.message).toContain("unavailable");
  });

  it("still allows a WORKER job through when failOpen is off", async () => {
    // Failing a worker job closed would strand an upload with no way to retry.
    withSettings({ failOpen: false });
    checkContentSafety.mockResolvedValue({ checked: false, blocked: false, reasons: [], result: null });

    expect(
      (await guardText("x", { surface: "quiz_extraction" }, { requestPath: false })).blocked
    ).toBe(false);
  });

  it("does not reject when the unavailable check was switched off anyway", async () => {
    withSettings({ failOpen: false, moderationEnabled: false, jailbreakMode: "OFF", offTopicMode: "OFF" });
    moderateText.mockResolvedValue({ checked: false, flagged: false, categories: [] });
    checkContentSafety.mockResolvedValue({ checked: false, blocked: false, reasons: [], result: null });

    expect(
      (await guardText("x", { surface: "question_authoring" }, { requestPath: true })).blocked
    ).toBe(false);
  });

  it("does not reject a disabled surface when fail-closed mode is enabled", async () => {
    withSettings({
      failOpen: false,
      moderationEnabled: true,
      jailbreakMode: "BLOCK",
      disabledSurfaces: ["question_authoring"],
    });
    moderateText.mockResolvedValue({ checked: false, flagged: false, categories: [] });
    checkContentSafety.mockResolvedValue({
      checked: false,
      blocked: false,
      reasons: [],
      result: null,
    });

    const decision = await guardText(
      "x",
      { surface: "question_authoring" },
      { requestPath: true }
    );
    expect(decision.blocked).toBe(false);
    expect(moderateText).not.toHaveBeenCalled();
  });
});

describe("guardChatTurn", () => {
  it("moderates the full model content but checks only the message text", async () => {
    const content = [
      { type: "text" as const, text: "look" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA" } },
    ];
    await guardChatTurn("look", content, { surface: "assistant_chat" });

    expect(moderateContent).toHaveBeenCalledWith(content, expect.anything());
    expect(checkContentSafety.mock.calls[0][0]).toBe("look");
  });

  it("blocks a flagged turn", async () => {
    moderateContent.mockResolvedValue({ checked: true, flagged: true, categories: ["sexual"] });
    expect((await guardChatTurn("x", "x", { surface: "assistant_chat" })).blocked).toBe(true);
  });

  it("defaults to the request path, so failOpen applies", async () => {
    withSettings({ failOpen: false });
    checkContentSafety.mockResolvedValue({ checked: false, blocked: false, reasons: [], result: null });
    expect((await guardChatTurn("x", "x", { surface: "assistant_chat" })).blocked).toBe(true);
  });
});

describe("auditText", () => {
  it("reports findings but NEVER blocks", async () => {
    moderateText.mockResolvedValue({ checked: true, flagged: true, categories: ["violence"] });
    checkContentSafety.mockResolvedValue({
      checked: true,
      blocked: true,
      reasons: ["jailbreak (0.99)"],
      result: null,
    });

    const decision = await auditText("...", { surface: "material_description" });
    expect(decision.blocked).toBe(false);
    expect(decision.message).toBeNull();
    expect(decision.reasons).toContain("jailbreak (0.99)");
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: false })
    );
  });

  it("does nothing at all when the surface is fully disabled", async () => {
    withSettings({ disabledSurfaces: ["material_description"], moderationEnabled: false });
    await auditText("x", { surface: "material_description" });
    expect(moderateText).not.toHaveBeenCalled();
    expect(checkContentSafety).not.toHaveBeenCalled();
  });
});

describe("event ids", () => {
  it("records a finding the user will see and returns its id", async () => {
    moderateText.mockResolvedValue({ checked: true, flagged: true, categories: ["violence"] });

    const decision = await guardText("...", { surface: "question_authoring", userId: "u1" });
    expect(decision.eventId).toBe("evt-1");
    expect(recordGuardrailEvent).toHaveBeenCalledWith({
      surface: "question_authoring",
      subjectId: null,
      userId: "u1",
      blocked: true,
      reasons: ["moderation:violence"],
    });
  });

  it("records a FLAG-only trip too — the audit path shows it as a warning", async () => {
    checkContentSafety.mockResolvedValue({
      checked: true,
      blocked: false,
      reasons: ["jailbreak (0.91)"],
      result: null,
    });

    const decision = await auditText("...", { surface: "quiz_extraction", id: "x1" });
    expect(decision.blocked).toBe(false);
    expect(decision.eventId).toBe("evt-1");
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      expect.objectContaining({ blocked: false, reasons: ["jailbreak (0.91)"] })
    );
  });

  it("writes NOTHING for content that passed", async () => {
    await guardText("hello", { surface: "question_authoring" });
    expect(recordGuardrailEvent).not.toHaveBeenCalled();
  });

  it("writes no event for an unavailable check — an outage is not a false positive", async () => {
    withSettings({ failOpen: false });
    checkContentSafety.mockResolvedValue({ checked: false, blocked: false, reasons: [], result: null });

    const decision = await guardText("x", { surface: "question_authoring" }, { requestPath: true });
    expect(decision.blocked).toBe(true);
    expect(decision.eventId).toBeNull();
    expect(recordGuardrailEvent).not.toHaveBeenCalled();
  });

  it("still blocks when the event could not be recorded", async () => {
    // The block already happened and is already in the audit log; losing the
    // record costs the user their report button and nothing else.
    recordGuardrailEvent.mockResolvedValue(null);
    moderateText.mockResolvedValue({ checked: true, flagged: true, categories: ["violence"] });

    const decision = await guardText("...", { surface: "question_authoring" });
    expect(decision.blocked).toBe(true);
    expect(decision.eventId).toBeNull();
  });
});
