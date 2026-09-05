import { describe, it, expect } from "vitest";
import {
  normalizeGuardrailSettings,
  defaultGuardrailSettings,
  policyFor,
  moderationEnabledFor,
  isGuardrailSurface,
  GUARDRAIL_SURFACES,
  GUARDRAIL_SURFACE_LABELS,
  MAX_TOPIC_DESCRIPTION_CHARS,
  type GuardrailSettings,
} from "./guardrail-settings";

// The DB read/write path is covered in test/guardrails.settings.route.test.ts.
// These cover the pure normalization and the per-surface resolution.

function settings(
  overrides: Partial<GuardrailSettings> = {},
): GuardrailSettings {
  return { ...defaultGuardrailSettings(), ...overrides };
}

describe("defaultGuardrailSettings", () => {
  it("keeps the free check on and the paid ones report-only", () => {
    const defaults = defaultGuardrailSettings();
    expect(defaults.moderationEnabled).toBe(true);
    expect(defaults.jailbreakMode).toBe("FLAG");
    expect(defaults.offTopicMode).toBe("OFF");
    expect(defaults.failOpen).toBe(true);
    expect(defaults.disabledSurfaces).toEqual([]);
  });
});

describe("GUARDRAIL_SURFACE_LABELS", () => {
  it("labels every registered surface", () => {
    for (const surface of GUARDRAIL_SURFACES) {
      expect(GUARDRAIL_SURFACE_LABELS[surface]).toBeTruthy();
    }
    expect(Object.keys(GUARDRAIL_SURFACE_LABELS)).toHaveLength(
      GUARDRAIL_SURFACES.length,
    );
  });
});

describe("normalizeGuardrailSettings", () => {
  it("accepts a well-formed payload", () => {
    expect(
      normalizeGuardrailSettings({
        moderationEnabled: false,
        jailbreakMode: "BLOCK",
        offTopicMode: "FLAG",
        jailbreakThreshold: 0.85,
        offTopicThreshold: 0.4,
        topicDescription: "  Only physics  ",
        failOpen: false,
        disabledSurfaces: ["assistant_reply"],
      }),
    ).toEqual({
      moderationEnabled: false,
      jailbreakMode: "BLOCK",
      offTopicMode: "FLAG",
      jailbreakThreshold: 0.85,
      offTopicThreshold: 0.4,
      topicDescription: "Only physics",
      failOpen: false,
      disabledSurfaces: ["assistant_reply"],
    });
  });

  it("falls back to defaults for every missing field", () => {
    expect(normalizeGuardrailSettings({})).toEqual(defaultGuardrailSettings());
  });

  it("rejects an unknown mode rather than storing it", () => {
    const result = normalizeGuardrailSettings({
      jailbreakMode: "block",
      offTopicMode: 7,
    });
    expect(result.jailbreakMode).toBe("FLAG");
    expect(result.offTopicMode).toBe("OFF");
  });

  it("clamps thresholds into 0–1", () => {
    const result = normalizeGuardrailSettings({
      jailbreakThreshold: 9,
      offTopicThreshold: -4,
    });
    expect(result.jailbreakThreshold).toBe(1);
    expect(result.offTopicThreshold).toBe(0);
  });

  it("degrades a non-numeric threshold to the default rather than NaN", () => {
    expect(
      normalizeGuardrailSettings({ jailbreakThreshold: "high" })
        .jailbreakThreshold,
    ).toBe(0.7);
  });

  it("caps the topic description", () => {
    const result = normalizeGuardrailSettings({
      topicDescription: "x".repeat(5_000),
    });
    expect(result.topicDescription).toHaveLength(MAX_TOPIC_DESCRIPTION_CHARS);
  });

  it("drops unknown surface keys", () => {
    const result = normalizeGuardrailSettings({
      disabledSurfaces: ["assistant_chat", "not_a_surface", 42],
    });
    expect(result.disabledSurfaces).toEqual(["assistant_chat"]);
  });

  it("stores surfaces in registry order regardless of submitted order", () => {
    const result = normalizeGuardrailSettings({
      disabledSurfaces: ["question_import", "assistant_chat"],
    });
    expect(result.disabledSurfaces).toEqual([
      "assistant_chat",
      "question_import",
    ]);
  });

  it("ignores a non-array disabledSurfaces", () => {
    expect(
      normalizeGuardrailSettings({ disabledSurfaces: "assistant_chat" })
        .disabledSurfaces,
    ).toEqual([]);
  });
});

describe("policyFor", () => {
  it("passes the configured modes and thresholds through", () => {
    expect(
      policyFor(
        settings({ jailbreakMode: "BLOCK", jailbreakThreshold: 0.9 }),
        "assistant_chat",
      ),
    ).toEqual({
      jailbreakMode: "BLOCK",
      offTopicMode: "OFF",
      jailbreakThreshold: 0.9,
      offTopicThreshold: 0.7,
    });
  });

  it("returns an INERT policy for a disabled surface, so no call is billed", () => {
    const policy = policyFor(
      settings({
        jailbreakMode: "BLOCK",
        disabledSurfaces: ["assistant_chat"],
      }),
      "assistant_chat",
    );
    expect(policy.jailbreakMode).toBe("OFF");
    expect(policy.offTopicMode).toBe("OFF");
  });

  it("leaves other surfaces alone when one is disabled", () => {
    const config = settings({
      jailbreakMode: "BLOCK",
      disabledSurfaces: ["assistant_chat"],
    });
    expect(policyFor(config, "question_import").jailbreakMode).toBe("BLOCK");
  });

  it("does not disable an unrecognised surface string", () => {
    const config = settings({
      jailbreakMode: "FLAG",
      disabledSurfaces: ["assistant_chat"],
    });
    expect(policyFor(config, "some_new_surface").jailbreakMode).toBe("FLAG");
  });
});

describe("moderationEnabledFor", () => {
  it("is off when moderation is switched off globally", () => {
    expect(
      moderationEnabledFor(
        settings({ moderationEnabled: false }),
        "assistant_chat",
      ),
    ).toBe(false);
  });

  it("is off for a disabled surface even when moderation is on", () => {
    expect(
      moderationEnabledFor(
        settings({ disabledSurfaces: ["material_page"] }),
        "material_page",
      ),
    ).toBe(false);
  });

  it("is on by default", () => {
    expect(moderationEnabledFor(settings(), "assistant_chat")).toBe(true);
  });
});

describe("isGuardrailSurface", () => {
  it("accepts registered surfaces and rejects anything else", () => {
    expect(GUARDRAIL_SURFACES.every(isGuardrailSurface)).toBe(true);
    expect([null, "", "nope", 1].some(isGuardrailSurface)).toBe(false);
  });
});
