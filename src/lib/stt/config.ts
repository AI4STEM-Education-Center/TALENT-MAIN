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
  const dedupedOptions = [...new Set(rawOptions)];
  const languageOptions: SttLanguageCode[] =
    dedupedOptions.length >= 2
      ? dedupedOptions
      : [...new Set([languageCode, ...defaults.languageOptions])];

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
      message: "Could not read STT settings; using defaults",
    });
    return DEFAULT_STT_SETTINGS;
  }

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
