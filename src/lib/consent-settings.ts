import { prisma } from "@/lib/prisma";

/**
 * Global, admin-editable resource limits for consent PDF/export generation —
 * singleton row, mirroring getSmtpConfig()'s shape. These are the knobs that
 * actually bound how much RAM, CPU time, and S3 storage a bulk export can
 * consume on a resource-constrained deployment; see
 * docs/plans/consent-compliance-plan.md §8b.
 */

export interface ConsentExportSettingsValue {
  maxEmailAttachmentBytes: number;
  bulkExportBatchSize: number;
  bulkExportInlineThreshold: number;
  bulkExportMaxRecords: number;
  bulkExportRetentionHours: number;
}

export const CONSENT_EXPORT_SETTINGS_DEFAULTS: ConsentExportSettingsValue = {
  maxEmailAttachmentBytes: 5_000_000,
  bulkExportBatchSize: 25,
  bulkExportInlineThreshold: 10,
  bulkExportMaxRecords: 2_000,
  bulkExportRetentionHours: 48,
};

/** Reads the singleton settings row, seeding it with defaults if it doesn't exist yet. */
export async function getConsentExportSettings(): Promise<ConsentExportSettingsValue> {
  const row = await prisma.consentExportSettings.findUnique({ where: { id: "singleton" } });
  if (!row) return { ...CONSENT_EXPORT_SETTINGS_DEFAULTS };
  return {
    maxEmailAttachmentBytes: row.maxEmailAttachmentBytes,
    bulkExportBatchSize: row.bulkExportBatchSize,
    bulkExportInlineThreshold: row.bulkExportInlineThreshold,
    bulkExportMaxRecords: row.bulkExportMaxRecords,
    bulkExportRetentionHours: row.bulkExportRetentionHours,
  };
}

const LIMITS: Record<keyof ConsentExportSettingsValue, { min: number; max: number }> = {
  maxEmailAttachmentBytes: { min: 100_000, max: 25_000_000 },
  bulkExportBatchSize: { min: 1, max: 500 },
  bulkExportInlineThreshold: { min: 0, max: 200 },
  bulkExportMaxRecords: { min: 1, max: 50_000 },
  bulkExportRetentionHours: { min: 1, max: 24 * 30 },
};

/** Clamp an admin-submitted value into a sane range for its field. */
export function clampConsentExportSetting(key: keyof ConsentExportSettingsValue, value: number): number {
  const { min, max } = LIMITS[key];
  if (!Number.isFinite(value)) return CONSENT_EXPORT_SETTINGS_DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

export async function updateConsentExportSettings(
  partial: Partial<ConsentExportSettingsValue>,
  updatedById: string
): Promise<ConsentExportSettingsValue> {
  const current = await getConsentExportSettings();
  const next: ConsentExportSettingsValue = { ...current };
  for (const key of Object.keys(LIMITS) as (keyof ConsentExportSettingsValue)[]) {
    if (partial[key] !== undefined) {
      next[key] = clampConsentExportSetting(key, partial[key]!);
    }
  }
  await prisma.consentExportSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...next, updatedById },
    update: { ...next, updatedById },
  });
  return next;
}
