// Read/write the singleton GuardrailConfig row, with the JSON-as-text column
// parsed into a real array and every value bounded — so a missing row, a
// hand-edited one, and a fresh install all behave like the shipped defaults.
//
// Mirrors src/lib/assistant/config.ts, which does the same job for the chat
// assistants. Which MODEL runs the checks is not here: that lives in
// AiUseCaseAssignment under the "moderation" and "guardrail" use cases, picked
// in the same AI Config panel as every other model choice.

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_GUARDRAIL_POLICY,
  isGuardrailMode,
  type GuardrailMode,
  type GuardrailPolicy,
} from "@/lib/guardrail-check";
import { invalidateGuardrailCheckCache } from "@/lib/guardrails";

/**
 * Every place a guardrail runs. An admin can switch one off without touching
 * the others — useful when one surface turns out to be noisy but the rest are
 * behaving.
 *
 * Stored as an opt-OUT list (`disabledSurfaces`), so a surface added in a later
 * release is guarded by default instead of staying dark until someone re-saves.
 */
export const GUARDRAIL_SURFACES = [
  "assistant_chat",
  "assistant_reply",
  "simulation_feedback",
  "quiz_extraction",
  "quiz_extraction_page",
  "material_page",
  "material_description",
  "question_authoring",
  "extraction_commit",
  "question_import",
] as const;

export type GuardrailSurface = (typeof GUARDRAIL_SURFACES)[number];

export function isGuardrailSurface(value: unknown): value is GuardrailSurface {
  return typeof value === "string" && (GUARDRAIL_SURFACES as readonly string[]).includes(value);
}

/** Labels for the admin panel. Kept beside the list so the two cannot drift. */
export const GUARDRAIL_SURFACE_LABELS: Record<GuardrailSurface, string> = {
  assistant_chat: "Chat — message in",
  assistant_reply: "Chat — reply out (audit)",
  simulation_feedback: "Simulation feedback",
  quiz_extraction: "Quiz PDF — extracted text",
  quiz_extraction_page: "Quiz PDF — page images",
  material_page: "Material PDF — page images",
  material_description: "Material PDF — descriptions (audit)",
  question_authoring: "Question authoring",
  extraction_commit: "Quiz PDF — commit to questions",
  question_import: "QTI question import",
};

export interface GuardrailSettings extends GuardrailPolicy {
  moderationEnabled: boolean;
  topicDescription: string;
  failOpen: boolean;
  disabledSurfaces: GuardrailSurface[];
}

export const MAX_TOPIC_DESCRIPTION_CHARS = 2_000;

/**
 * What a missing row falls back to. `moderationEnabled: true` because that
 * check is free and needs no calibration; the LLM checks ship in report-only
 * mode (see DEFAULT_GUARDRAIL_POLICY).
 */
export function defaultGuardrailSettings(): GuardrailSettings {
  return {
    ...DEFAULT_GUARDRAIL_POLICY,
    moderationEnabled: true,
    topicDescription: "",
    failOpen: true,
    disabledSurfaces: [],
  };
}

// Applied on write AND on read, so a hand-edited row cannot put the checks into
// a state the server would not accept through the form.
export const THRESHOLD_BOUNDS = { min: 0, max: 1 } as const;

function clampThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(THRESHOLD_BOUNDS.max, Math.max(THRESHOLD_BOUNDS.min, value));
}

function readMode(value: unknown, fallback: GuardrailMode): GuardrailMode {
  return isGuardrailMode(value) ? value : fallback;
}

function parseSurfaces(raw: string): GuardrailSurface[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Preserve registry order so the stored value is stable regardless of the
  // order the form submitted, and drop keys that no longer exist.
  const wanted = new Set(parsed.filter(isGuardrailSurface));
  return GUARDRAIL_SURFACES.filter((surface) => wanted.has(surface));
}

// The settings are read on nearly every AI call, so they are cached with the
// same 60s TTL as the provider assignments in ai-provider.ts.
const CACHE_TTL_MS = 60_000;
let _cache: { data: GuardrailSettings; expiresAt: number } | null = null;

/** Drop the cached settings AND every cached verdict computed under them. */
export function invalidateGuardrailSettings(): void {
  _cache = null;
  invalidateGuardrailCheckCache();
}

export async function getGuardrailSettings(): Promise<GuardrailSettings> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.data;

  const defaults = defaultGuardrailSettings();
  let settings = defaults;

  try {
    const row = await prisma.guardrailConfig.findUnique({ where: { id: "singleton" } });
    if (row) {
      settings = {
        moderationEnabled: row.moderationEnabled,
        jailbreakMode: readMode(row.jailbreakMode, defaults.jailbreakMode),
        offTopicMode: readMode(row.offTopicMode, defaults.offTopicMode),
        jailbreakThreshold: clampThreshold(row.jailbreakThreshold, defaults.jailbreakThreshold),
        offTopicThreshold: clampThreshold(row.offTopicThreshold, defaults.offTopicThreshold),
        topicDescription: (row.topicDescription ?? "").slice(0, MAX_TOPIC_DESCRIPTION_CHARS),
        failOpen: row.failOpen,
        disabledSurfaces: parseSurfaces(row.disabledSurfaces),
      };
    }
  } catch (error) {
    // A database blip must not decide the safety posture by accident. The
    // defaults are report-only, so falling back to them is the same "observe,
    // don't enforce" stance the feature ships in.
    console.error("[Guardrails] Could not read settings; using defaults:", error);
    return defaults;
  }

  _cache = { data: settings, expiresAt: Date.now() + CACHE_TTL_MS };
  return settings;
}

export interface GuardrailSettingsInput {
  moderationEnabled?: unknown;
  jailbreakMode?: unknown;
  offTopicMode?: unknown;
  jailbreakThreshold?: unknown;
  offTopicThreshold?: unknown;
  topicDescription?: unknown;
  failOpen?: unknown;
  disabledSurfaces?: unknown;
}

/** Coerce arbitrary request input into a valid settings object. Never throws. */
export function normalizeGuardrailSettings(input: GuardrailSettingsInput): GuardrailSettings {
  const defaults = defaultGuardrailSettings();
  const surfaces = Array.isArray(input.disabledSurfaces)
    ? input.disabledSurfaces.filter(isGuardrailSurface)
    : [];

  return {
    moderationEnabled:
      typeof input.moderationEnabled === "boolean"
        ? input.moderationEnabled
        : defaults.moderationEnabled,
    jailbreakMode: readMode(input.jailbreakMode, defaults.jailbreakMode),
    offTopicMode: readMode(input.offTopicMode, defaults.offTopicMode),
    jailbreakThreshold: clampThreshold(input.jailbreakThreshold, defaults.jailbreakThreshold),
    offTopicThreshold: clampThreshold(input.offTopicThreshold, defaults.offTopicThreshold),
    topicDescription:
      typeof input.topicDescription === "string"
        ? input.topicDescription.trim().slice(0, MAX_TOPIC_DESCRIPTION_CHARS)
        : defaults.topicDescription,
    failOpen: typeof input.failOpen === "boolean" ? input.failOpen : defaults.failOpen,
    disabledSurfaces: GUARDRAIL_SURFACES.filter((surface) => surfaces.includes(surface)),
  };
}

export async function saveGuardrailSettings(
  input: GuardrailSettingsInput
): Promise<GuardrailSettings> {
  const settings = normalizeGuardrailSettings(input);
  const data = {
    moderationEnabled: settings.moderationEnabled,
    jailbreakMode: settings.jailbreakMode,
    offTopicMode: settings.offTopicMode,
    jailbreakThreshold: settings.jailbreakThreshold,
    offTopicThreshold: settings.offTopicThreshold,
    topicDescription: settings.topicDescription,
    failOpen: settings.failOpen,
    disabledSurfaces: JSON.stringify(settings.disabledSurfaces),
  };

  await prisma.guardrailConfig.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });

  invalidateGuardrailSettings();
  return settings;
}

/** The policy half of the settings, for handing to `checkContentSafety`. */
export function policyFor(settings: GuardrailSettings, surface: string): GuardrailPolicy {
  // A disabled surface gets an inert policy, which makes checkContentSafety
  // return before it resolves a provider or bills a call.
  if (isGuardrailSurface(surface) && settings.disabledSurfaces.includes(surface)) {
    return { ...settings, jailbreakMode: "OFF", offTopicMode: "OFF" };
  }
  return {
    jailbreakMode: settings.jailbreakMode,
    offTopicMode: settings.offTopicMode,
    jailbreakThreshold: settings.jailbreakThreshold,
    offTopicThreshold: settings.offTopicThreshold,
  };
}

/** Whether the free moderation pass should run for a surface. */
export function moderationEnabledFor(settings: GuardrailSettings, surface: string): boolean {
  if (!settings.moderationEnabled) return false;
  return !(isGuardrailSurface(surface) && settings.disabledSurfaces.includes(surface));
}
