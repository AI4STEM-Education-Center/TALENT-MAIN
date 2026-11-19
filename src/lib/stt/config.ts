// Read/write the singleton Speech-to-Text (STT) configuration stored in
// `AssistantConfig` (id = "stt", audience = "stt").
//
// Storing STT settings in `AssistantConfig` means no schema migration or extra
// table is required, and settings are cached in-memory with a 60s TTL just like
// the assistant and guardrail configs.

import { prisma } from "@/lib/prisma";
import { logSystemEvent } from "@/lib/system-log";
import {
  DEFAULT_STT_SETTINGS,
  isAwsTranscribeRegion,
  isSttLanguageCode,
  isSttPartialStability,
  type SttLanguageCode,
  type SttSettings,
} from "./types";

const STT_CONFIG_ID = "stt";
const CACHE_TTL_MS = 60_000;

let _cache: { data: SttSettings; expiresAt: number } | null = null;
let _lastKnownSettings: SttSettings | null = null;

export function invalidateSttSettingsCache(): void {
  _cache = null;
}

export interface SttSettingsInput {
  enabled?: unknown;
  provider?: unknown;
  region?: unknown;
  languageCode?: unknown;
  identifyLanguage?: unknown;
  languageOptions?: unknown;
  enablePartialResultsStabilization?: unknown;
  partialResultsStability?: unknown;
}

/**
 * Deduplicate language codes so at most one dialect per base language family
 * (e.g. `en-US` vs `en-GB`) appears, with `preferred` always winning its family
 * and included in the list.
 */
export function sanitizeLanguageOptions(
  raw: readonly SttLanguageCode[],
  preferred: SttLanguageCode,
): SttLanguageCode[] {
  const prefFamily = preferred.split("-")[0].toLowerCase();
  // Replace any other dialect of the preferred language's base family with `preferred`,
  // while preserving the caller's ordering.
  const withPreferredReplaced: SttLanguageCode[] = raw.map((c) =>
    c.split("-")[0].toLowerCase() === prefFamily ? preferred : c,
  );
  if (!withPreferredReplaced.includes(preferred)) {
    withPreferredReplaced.unshift(preferred);
  }

  const seenFamilies = new Set<string>();
  const result: SttLanguageCode[] = [];
  for (const code of withPreferredReplaced) {
    const family = code.split("-")[0].toLowerCase();
    if (seenFamilies.has(family)) continue;
    seenFamilies.add(family);
    result.push(code);
  }
  if (result.length < 2) {
    for (const fallback of DEFAULT_STT_SETTINGS.languageOptions) {
      const family = fallback.split("-")[0].toLowerCase();
      if (!seenFamilies.has(family)) {
        seenFamilies.add(family);
        result.push(fallback);
      }
      if (result.length >= 2) break;
    }
  }
  return result;
}

export function normalizeSttSettings(input: SttSettingsInput): SttSettings {
  const defaults = DEFAULT_STT_SETTINGS;

  const enabled =
    typeof input.enabled === "boolean" ? input.enabled : defaults.enabled;

  const rawRegion =
    typeof input.region === "string" ? input.region.trim().toLowerCase() : "";
  const region = isAwsTranscribeRegion(rawRegion) ? rawRegion : "";

  const languageCode: SttLanguageCode = isSttLanguageCode(input.languageCode)
    ? input.languageCode
    : defaults.languageCode;

  const rawOptions = Array.isArray(input.languageOptions)
    ? input.languageOptions.filter(isSttLanguageCode)
    : defaults.languageOptions;
  const languageOptions = sanitizeLanguageOptions(rawOptions, languageCode);

  const identifyLanguage =
    typeof input.identifyLanguage === "boolean"
      ? input.identifyLanguage && languageOptions.length >= 2
      : defaults.identifyLanguage;

  const enablePartialResultsStabilization =
    typeof input.enablePartialResultsStabilization === "boolean"
      ? input.enablePartialResultsStabilization
      : defaults.enablePartialResultsStabilization;

  const partialResultsStability = isSttPartialStability(
    input.partialResultsStability,
  )
    ? input.partialResultsStability
    : defaults.partialResultsStability;

  return {
    enabled,
    provider: "aws_transcribe",
    region,
    languageCode,
    identifyLanguage,
    languageOptions,
    enablePartialResultsStabilization,
    partialResultsStability,
  };
}

export async function getSttSettings(): Promise<SttSettings> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.data;

  let settings = DEFAULT_STT_SETTINGS;
  try {
    const row = await prisma.assistantConfig.findUnique({
      where: { id: STT_CONFIG_ID },
    });
    if (row) {
      let parsed: SttSettingsInput = {};
      if (row.extraInstructions) {
        try {
          parsed = JSON.parse(row.extraInstructions) as SttSettingsInput;
        } catch {
          parsed = {};
        }
      }
      settings = normalizeSttSettings({
        ...parsed,
        enabled: row.enabled,
      });
    }
  } catch {
    void logSystemEvent({
      category: "SYSTEM",
      type: "STT_SETTINGS_READ_FAILED",
      severity: "WARNING",
      message:
        "Could not read STT settings; preserving last known state or failing closed",
    });
    // Preserve last known setting if available; otherwise fail closed
    // (`enabled: false`) so a DB error cannot re-enable paid AWS transcription
    // when an admin disabled it.
    return _lastKnownSettings ?? { ...DEFAULT_STT_SETTINGS, enabled: false };
  }

  _lastKnownSettings = settings;
  _cache = { data: settings, expiresAt: Date.now() + CACHE_TTL_MS };
  return settings;
}

export async function saveSttSettings(
  input: SttSettingsInput,
): Promise<SttSettings> {
  const current = await getSttSettings();
  const next = normalizeSttSettings({
    ...current,
    ...input,
  });

  const payload = JSON.stringify({
    provider: next.provider,
    region: next.region,
    languageCode: next.languageCode,
    identifyLanguage: next.identifyLanguage,
    languageOptions: next.languageOptions,
    enablePartialResultsStabilization: next.enablePartialResultsStabilization,
    partialResultsStability: next.partialResultsStability,
  });

  await prisma.assistantConfig.upsert({
    where: { id: STT_CONFIG_ID },
    update: {
      enabled: next.enabled,
      extraInstructions: payload,
    },
    create: {
      id: STT_CONFIG_ID,
      audience: STT_CONFIG_ID,
      enabled: next.enabled,
      extraInstructions: payload,
    },
  });

  invalidateSttSettingsCache();
  return next;
}
