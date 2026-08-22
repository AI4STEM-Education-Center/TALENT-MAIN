// Read/write the per-audience AssistantConfig row, with the JSON-as-text columns
// parsed into real arrays and every value defaulted so a missing row behaves
// exactly like a disabled assistant (the state a fresh install is in).

import { prisma } from "@/lib/prisma";
import { ATTACHMENT_KINDS, isAttachmentKind, type AssistantAudience, type AttachmentKind } from "./types";
import { listSkills } from "./skills";

export type AssistantSettings = {
  audience: AssistantAudience;
  enabled: boolean;
  extraInstructions: string;
  enabledSkills: string[];
  attachmentKinds: AttachmentKind[];
  maxAttachments: number;
  maxAttachmentBytes: number;
  maxToolCalls: number;
  maxHistoryMessages: number;
  turnsPerHour: number;
};

/**
 * The defaults a missing row falls back to. `enabled: false` is deliberate — an
 * admin has to pick a provider/model and turn the assistant on before any
 * student or teacher can talk to it.
 */
export function defaultSettings(audience: AssistantAudience): AssistantSettings {
  return {
    audience,
    enabled: false,
    extraInstructions: "",
    // Fresh installs get every skill for their audience: the admin's choice is
    // whether the assistant is on, not which of its built-in abilities work.
    enabledSkills: listSkills(audience).map((skill) => skill.id),
    attachmentKinds: ["image"],
    maxAttachments: 4,
    maxAttachmentBytes: 5 * 1024 * 1024,
    maxToolCalls: 6,
    maxHistoryMessages: 20,
    turnsPerHour: 60,
  };
}

// Bounds applied on write AND on read: a hand-edited row can't push the agent
// loop or the request size past what the server is willing to serve.
export const SETTINGS_BOUNDS = {
  maxAttachments: { min: 0, max: 8 },
  maxAttachmentBytes: { min: 64 * 1024, max: 10 * 1024 * 1024 },
  maxToolCalls: { min: 1, max: 12 },
  maxHistoryMessages: { min: 2, max: 40 },
  turnsPerHour: { min: 1, max: 500 },
} as const;

export const MAX_EXTRA_INSTRUCTIONS_CHARS = 4_000;

function clamp(value: number, bounds: { min: number; max: number }): number {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)));
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Keep only skill ids that are still registered for this audience. A skill
 * deleted from the code leaves a stale id in the DB; dropping it here means the
 * assistant degrades instead of failing to load.
 */
function reconcileSkills(audience: AssistantAudience, ids: string[]): string[] {
  const known = new Set(listSkills(audience).map((skill) => skill.id));
  return ids.filter((id) => known.has(id));
}

function reconcileKinds(kinds: string[]): AttachmentKind[] {
  const filtered = kinds.filter(isAttachmentKind);
  // Preserve registry order so the UI listing is stable regardless of save order.
  return ATTACHMENT_KINDS.filter((kind) => filtered.includes(kind));
}

export async function getAssistantSettings(
  audience: AssistantAudience
): Promise<AssistantSettings> {
  const row = await prisma.assistantConfig.findUnique({ where: { id: audience } });
  if (!row) return defaultSettings(audience);

  return {
    audience,
    enabled: row.enabled,
    extraInstructions: (row.extraInstructions ?? "").slice(0, MAX_EXTRA_INSTRUCTIONS_CHARS),
    enabledSkills: reconcileSkills(audience, parseStringArray(row.enabledSkills)),
    attachmentKinds: reconcileKinds(parseStringArray(row.attachmentKinds)),
    maxAttachments: clamp(row.maxAttachments, SETTINGS_BOUNDS.maxAttachments),
    maxAttachmentBytes: clamp(row.maxAttachmentBytes, SETTINGS_BOUNDS.maxAttachmentBytes),
    maxToolCalls: clamp(row.maxToolCalls, SETTINGS_BOUNDS.maxToolCalls),
    maxHistoryMessages: clamp(row.maxHistoryMessages, SETTINGS_BOUNDS.maxHistoryMessages),
    turnsPerHour: clamp(row.turnsPerHour, SETTINGS_BOUNDS.turnsPerHour),
  };
}

/**
 * A partial update. `enabledSkills` and `attachmentKinds` are typed loosely on
 * purpose — both are reconciled against the code registries below, so a caller
 * can forward raw strings straight off the wire without casting.
 */
export type AssistantSettingsPatch = Partial<
  Omit<AssistantSettings, "audience" | "attachmentKinds">
> & { attachmentKinds?: string[] };

/**
 * Upsert one audience's settings. Every numeric field is clamped and every id
 * list reconciled against the code registries, so an out-of-range or unknown
 * value is corrected rather than rejected — the admin form can't wedge the row.
 *
 * Fields the patch omits keep their stored value: an explicit `undefined` is
 * stripped rather than spread, which a plain `{...current, ...patch}` would
 * blank out.
 */
export async function saveAssistantSettings(
  audience: AssistantAudience,
  patch: AssistantSettingsPatch
): Promise<AssistantSettings> {
  const current = await getAssistantSettings(audience);
  const provided = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as AssistantSettingsPatch;
  const next = { ...current, ...provided };

  const data = {
    audience,
    enabled: next.enabled,
    extraInstructions: next.extraInstructions.slice(0, MAX_EXTRA_INSTRUCTIONS_CHARS) || null,
    enabledSkills: JSON.stringify(reconcileSkills(audience, next.enabledSkills)),
    attachmentKinds: JSON.stringify(reconcileKinds(next.attachmentKinds)),
    maxAttachments: clamp(next.maxAttachments, SETTINGS_BOUNDS.maxAttachments),
    maxAttachmentBytes: clamp(next.maxAttachmentBytes, SETTINGS_BOUNDS.maxAttachmentBytes),
    maxToolCalls: clamp(next.maxToolCalls, SETTINGS_BOUNDS.maxToolCalls),
    maxHistoryMessages: clamp(next.maxHistoryMessages, SETTINGS_BOUNDS.maxHistoryMessages),
    turnsPerHour: clamp(next.turnsPerHour, SETTINGS_BOUNDS.turnsPerHour),
  };

  await prisma.assistantConfig.upsert({
    where: { id: audience },
    update: data,
    create: { id: audience, ...data },
  });

  return getAssistantSettings(audience);
}
