// Export/import of the whole AI configuration as one JSON file, so a setup
// tuned on dev can be carried to prod (and back) without re-typing it.
//
// The bundle is keyed by NAMES, never by row ids: ids are cuids minted per
// database, so the same "Production OpenAI" provider has a different id on
// every site. A provider is matched on (name, providerType), a model inside it
// on (modelId, serviceTier) — the same pair its unique constraint uses.
//
// API keys travel in PLAINTEXT. They are stored encrypted under
// API_KEY_ENCRYPTION_SECRET, which differs per environment, so ciphertext from
// one site cannot be decrypted by another. The export file is therefore a
// secret and the admin UI says so.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import {
  API_SURFACES,
  invalidateProviderCache,
  isUseCase,
  resolveThinkingLevel,
  THINKING_LEVELS,
  USE_CASES,
  type UseCase,
} from "@/lib/ai-provider";
import {
  getAssistantSettings,
  MAX_EXTRA_INSTRUCTIONS_CHARS,
  saveAssistantSettings,
} from "@/lib/assistant/config";
import { ASSISTANT_AUDIENCES } from "@/lib/assistant/types";
import {
  getGuardrailSettings,
  saveGuardrailSettings,
} from "@/lib/guardrail-settings";

export const AI_CONFIG_FORMAT = "talent-ai-config";
export const AI_CONFIG_VERSION = 1;

// Mirrors the bounds enforced by /api/admin/ai-providers.
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;

const modelSchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  displayName: z.string().max(200).nullable().default(null),
  serviceTier: z.string().max(40).nullable().default(null),
  isDefault: z.boolean().default(false),
});

const providerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    providerType: z.enum(["openai", "local", "cloudflare"]),
    baseUrl: z.string().trim().max(2_000).nullable().default(null),
    apiKey: z.string().max(4_000).nullable().default(null),
    cfAigByokAlias: z.string().max(200).nullable().default(null),
    timeoutMs: z
      .number()
      .int()
      .min(MIN_TIMEOUT_MS)
      .max(MAX_TIMEOUT_MS)
      .nullable()
      .default(null),
    apiSurface: z.enum(API_SURFACES).nullable().default(null),
    isActive: z.boolean().default(true),
    models: z.array(modelSchema).max(500).default([]),
  })
  .refine((p) => p.providerType === "openai" || !!p.baseUrl, {
    message: "local and cloudflare providers need a baseUrl",
  });

const assignmentSchema = z.object({
  providerName: z.string().min(1),
  providerType: z.string().min(1),
  modelId: z.string().min(1),
  serviceTier: z.string().nullable().default(null),
  thinkingLevel: z.enum(THINKING_LEVELS).nullable().default(null),
});

// Shapes only; saveAssistantSettings clamps the numbers and reconciles the id
// lists against the code registries, as it does for the admin form.
const assistantSchema = z.object({
  audience: z.string(),
  enabled: z.boolean().optional(),
  extraInstructions: z.string().max(MAX_EXTRA_INSTRUCTIONS_CHARS).optional(),
  enabledSkills: z.array(z.string().max(100)).max(50).optional(),
  disabledTools: z.array(z.string().max(100)).max(200).optional(),
  attachmentKinds: z.array(z.string().max(40)).max(20).optional(),
  maxAttachments: z.number().int().optional(),
  maxAttachmentBytes: z.number().int().optional(),
  attachmentRetentionDays: z.number().int().optional(),
  historyRetentionDays: z.number().int().optional(),
  maxToolCalls: z.number().int().optional(),
  maxHistoryMessages: z.number().int().optional(),
  turnsPerHour: z.number().int().optional(),
});

const bundleSchema = z.object({
  format: z.literal(AI_CONFIG_FORMAT),
  version: z.literal(AI_CONFIG_VERSION),
  exportedAt: z.string().optional(),
  providers: z.array(providerSchema).max(100),
  // Keyed by use case. Unknown use cases (a newer export read by an older
  // site) are dropped rather than rejected, see parseAiConfigBundle.
  assignments: z.record(z.string(), assignmentSchema.nullable()).default({}),
  assistants: z.array(assistantSchema).max(10).optional(),
  // saveGuardrailSettings coerces every field itself and never throws, so the
  // object is carried loosely here.
  guardrails: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type AiConfigBundle = z.infer<typeof bundleSchema>;
export type AiConfigProviderEntry = z.infer<typeof providerSchema>;

/** Stable identity of a provider across sites. */
export function providerKey(p: { name: string; providerType: string }) {
  return `${p.providerType}:${p.name}`;
}

/** Build the export of everything: providers, keys, models, assignments, assistants, guardrails. */
export async function buildAiConfigExport(): Promise<AiConfigBundle> {
  const [providers, assignments, assistants, guardrails] = await Promise.all([
    prisma.aiProvider.findMany({
      orderBy: { createdAt: "asc" },
      include: { models: { orderBy: { modelId: "asc" } } },
    }),
    prisma.aiUseCaseAssignment.findMany({
      include: { provider: true, model: true },
    }),
    Promise.all(ASSISTANT_AUDIENCES.map((a) => getAssistantSettings(a))),
    getGuardrailSettings(),
  ]);

  const byUseCase = new Map(assignments.map((a) => [a.useCase, a]));
  const assignmentMap: AiConfigBundle["assignments"] = {};
  for (const useCase of USE_CASES) {
    const a = byUseCase.get(useCase);
    assignmentMap[useCase] = a
      ? {
          providerName: a.provider.name,
          providerType: a.provider.providerType,
          modelId: a.model.modelId,
          serviceTier: a.model.serviceTier,
          thinkingLevel: resolveThinkingLevel(
            a.thinkingLevel,
            a.model.thinkingLevel,
          ),
        }
      : null;
  }

  return {
    format: AI_CONFIG_FORMAT,
    version: AI_CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
    providers: providers.map((p) => ({
      name: p.name,
      providerType: p.providerType as AiConfigProviderEntry["providerType"],
      baseUrl: p.baseUrl,
      apiKey: readApiKey(p),
      cfAigByokAlias: p.cfAigByokAlias,
      timeoutMs: p.timeoutMs,
      apiSurface: p.apiSurface as AiConfigProviderEntry["apiSurface"],
      isActive: p.isActive,
      models: p.models.map((m) => ({
        modelId: m.modelId,
        displayName: m.displayName,
        serviceTier: m.serviceTier,
        isDefault: m.isDefault,
      })),
    })),
    assignments: assignmentMap,
    assistants,
    guardrails: { ...guardrails },
  };
}

function readApiKey(p: {
  apiKeyEnc: string | null;
  apiKeyIv: string | null;
  apiKeyTag: string | null;
}): string | null {
  if (!p.apiKeyEnc || !p.apiKeyIv || !p.apiKeyTag) return null;
  try {
    return decryptApiKey(p.apiKeyEnc, p.apiKeyIv, p.apiKeyTag);
  } catch {
    // Undecryptable under this site's secret — export the provider without it
    // rather than failing the whole file.
    return null;
  }
}

/** Validate an uploaded bundle. Returns the parsed bundle or a readable error. */
export function parseAiConfigBundle(
  raw: unknown,
): { bundle: AiConfigBundle } | { error: string } {
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return {
      error: `Not a valid AI config export${where}: ${issue?.message ?? "invalid"}`,
    };
  }
  const bundle = parsed.data;
  const keys = new Set<string>();
  for (const p of bundle.providers) {
    const key = providerKey(p);
    if (keys.has(key)) {
      return {
        error: `Duplicate provider in file: ${p.name} (${p.providerType})`,
      };
    }
    keys.add(key);
  }
  bundle.assignments = Object.fromEntries(
    Object.entries(bundle.assignments).filter(([uc]) => isUseCase(uc)),
  );
  return { bundle };
}

export interface AiConfigImportOptions {
  /** providerKey()s from the bundle to import. Omitted = all. */
  providers?: string[];
  /** Use cases from the bundle to import. Omitted = all. */
  useCases?: string[];
  assistants?: boolean;
  guardrails?: boolean;
  /**
   * Delete every existing provider (and with it every model and assignment)
   * before importing, so the site ends up with exactly the selected config.
   */
  replaceExisting?: boolean;
}

export interface AiConfigImportReport {
  providers: { name: string; providerType: string; result: string }[];
  useCases: { useCase: string; result: string }[];
  assistants: string | null;
  guardrails: string | null;
  removedProviders: number;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Apply a parsed bundle. Providers and assignments are written in a single
 * transaction, so a failure part way leaves the old config intact — that
 * matters most with `replaceExisting`, which deletes first.
 *
 * A selected use case whose provider was NOT selected still imports when the
 * target site already has a provider with that name/type and the model: that
 * is how "just copy the assignments over" works between two sites that
 * already share providers.
 */
export async function applyAiConfigImport(
  bundle: AiConfigBundle,
  options: AiConfigImportOptions,
): Promise<AiConfigImportReport> {
  const wantedProviders = options.providers ? new Set(options.providers) : null;
  const wantedUseCases = options.useCases ? new Set(options.useCases) : null;

  const report: AiConfigImportReport = {
    providers: [],
    useCases: [],
    assistants: null,
    guardrails: null,
    removedProviders: 0,
  };

  await prisma.$transaction(
    async (tx) => {
      if (options.replaceExisting) {
        // Assignments and models cascade from the provider.
        const removed = await tx.aiProvider.deleteMany({});
        report.removedProviders = removed.count;
      }

      for (const entry of bundle.providers) {
        if (wantedProviders && !wantedProviders.has(providerKey(entry)))
          continue;
        report.providers.push({
          name: entry.name,
          providerType: entry.providerType,
          result: await upsertProvider(tx, entry),
        });
      }

      for (const useCase of USE_CASES) {
        if (!(useCase in bundle.assignments)) continue;
        if (wantedUseCases && !wantedUseCases.has(useCase)) continue;
        report.useCases.push({
          useCase,
          result: await applyAssignment(
            tx,
            useCase,
            bundle.assignments[useCase] ?? null,
          ),
        });
      }
    },
    { timeout: 30_000 },
  );

  invalidateProviderCache();

  // Outside the transaction: these go through their own save paths, which
  // normalize every field and refresh their own caches.
  if (options.assistants && bundle.assistants) {
    let saved = 0;
    for (const { audience: raw, ...patch } of bundle.assistants) {
      const audience = ASSISTANT_AUDIENCES.find((a) => a === raw);
      if (!audience) continue;
      await saveAssistantSettings(audience, patch);
      saved++;
    }
    report.assistants = `saved ${saved}`;
  }
  if (options.guardrails && bundle.guardrails) {
    await saveGuardrailSettings(bundle.guardrails);
    report.guardrails = "saved";
  }

  return report;
}

async function upsertProvider(
  tx: Tx,
  entry: AiConfigProviderEntry,
): Promise<string> {
  const existing = await tx.aiProvider.findFirst({
    where: { name: entry.name, providerType: entry.providerType },
  });

  if (
    entry.providerType === "cloudflare" &&
    !entry.apiKey &&
    !existing?.apiKeyEnc
  ) {
    return "skipped (Cloudflare AI Gateway providers need a CF_AIG_TOKEN)";
  }

  const enc = entry.apiKey ? encryptApiKey(entry.apiKey) : null;
  const data = {
    baseUrl: entry.baseUrl || null,
    cfAigByokAlias:
      entry.providerType === "cloudflare" ? entry.cfAigByokAlias : null,
    timeoutMs: entry.timeoutMs,
    apiSurface: entry.apiSurface,
    isActive: entry.isActive,
    // A file without a key never erases the one already stored here.
    ...(enc
      ? { apiKeyEnc: enc.encrypted, apiKeyIv: enc.iv, apiKeyTag: enc.tag }
      : {}),
  };

  const provider = existing
    ? await tx.aiProvider.update({ where: { id: existing.id }, data })
    : await tx.aiProvider.create({
        data: { name: entry.name, providerType: entry.providerType, ...data },
      });

  let added = 0;
  let updated = 0;
  for (const m of entry.models) {
    // findFirst rather than the compound unique: serviceTier is nullable and
    // SQLite treats NULLs as distinct, so the unique lookup can't match them.
    const found = await tx.aiModel.findFirst({
      where: {
        providerId: provider.id,
        modelId: m.modelId,
        serviceTier: m.serviceTier,
      },
    });
    const modelData = { displayName: m.displayName, isDefault: m.isDefault };
    if (found) {
      await tx.aiModel.update({ where: { id: found.id }, data: modelData });
      updated++;
    } else {
      await tx.aiModel.create({
        data: {
          providerId: provider.id,
          modelId: m.modelId,
          serviceTier: m.serviceTier,
          ...modelData,
        },
      });
      added++;
    }
  }

  const verb = existing ? "updated" : "created";
  const keyNote = enc ? "" : existing?.apiKeyEnc ? ", kept existing key" : "";
  return `${verb} (${added} model(s) added, ${updated} updated${keyNote})`;
}

async function applyAssignment(
  tx: Tx,
  useCase: UseCase,
  entry: z.infer<typeof assignmentSchema> | null,
): Promise<string> {
  if (!entry) {
    await tx.aiUseCaseAssignment.deleteMany({ where: { useCase } });
    return "cleared (unassigned in file)";
  }

  const provider = await tx.aiProvider.findFirst({
    where: { name: entry.providerName, providerType: entry.providerType },
  });
  if (!provider) {
    return `skipped (provider "${entry.providerName}" not on this site — select it too)`;
  }
  const model = await tx.aiModel.findFirst({
    where: {
      providerId: provider.id,
      modelId: entry.modelId,
      serviceTier: entry.serviceTier,
    },
  });
  if (!model) {
    return `skipped (model ${entry.modelId} not on provider "${provider.name}")`;
  }

  const data = {
    providerId: provider.id,
    modelId: model.id,
    thinkingLevel: entry.thinkingLevel,
  };
  await tx.aiUseCaseAssignment.upsert({
    where: { useCase },
    update: data,
    create: { useCase, ...data },
  });
  return `assigned ${provider.name} — ${model.displayName || model.modelId}`;
}
