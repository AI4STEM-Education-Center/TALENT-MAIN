// Client-side parse + upload helpers for the three admin CSV imports. Pure
// orchestration (no React) so the presentational UploadCard component stays
// small and these can be unit-tested independently of rendering.

import {
  parseConceptsCsv,
  parseMisconceptionsCsv,
  parseMappingsCsv,
  CsvHeaderError,
} from "@/lib/concept-csv";

export interface UploadResult {
  ok: boolean;
  message: string;
  details?: string[];
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Upload failed.");
  }
  return data;
}

function describeError(error: unknown, fallback: string): UploadResult {
  if (error instanceof CsvHeaderError) return { ok: false, message: error.message };
  return { ok: false, message: error instanceof Error ? error.message : fallback };
}

export async function uploadConceptsCsv(text: string): Promise<UploadResult> {
  try {
    const { concepts, skipped } = parseConceptsCsv(text);
    if (concepts.length === 0) {
      return { ok: false, message: "No valid concept rows found in this file." };
    }
    if (skipped.length > 0) {
      return {
        ok: false,
        message: `Import cancelled: fix the ${skipped.length} invalid row(s) before uploading again. No data was changed.`,
        details: skipped.map((s) => `Row ${s.row}: ${s.reason}`),
      };
    }
    const data = await postJson("/api/admin/concepts/import", { concepts });
    return {
      ok: true,
      message:
        `Imported concepts — ${data.created} created, ${data.updated} updated, ${data.deprecated} absent row(s) deprecated.`,
    };
  } catch (error) {
    return describeError(error, "Failed to import concepts.");
  }
}

export async function uploadMisconceptionsCsv(text: string): Promise<UploadResult> {
  try {
    const { misconceptions, skipped } = parseMisconceptionsCsv(text);
    if (misconceptions.length === 0) {
      return { ok: false, message: "No valid misconception rows found in this file." };
    }
    if (skipped.length > 0) {
      return {
        ok: false,
        message: `Import cancelled: fix the ${skipped.length} invalid row(s) before uploading again. No data was changed.`,
        details: skipped.map((s) => `Row ${s.row}: ${s.reason}`),
      };
    }
    const data = await postJson("/api/admin/misconceptions/import", { misconceptions });
    return {
      ok: true,
      message:
        `Imported misconceptions — ${data.created} created, ${data.updated} updated, ${data.deprecated} absent row(s) deprecated.`,
    };
  } catch (error) {
    return describeError(error, "Failed to import misconceptions.");
  }
}

export async function uploadMappingsCsv(text: string): Promise<UploadResult> {
  try {
    const { mappings, externalRefs, skipped } = parseMappingsCsv(text);
    if (mappings.length === 0 && externalRefs.length === 0) {
      return { ok: false, message: "No valid mapping or external-reference rows found in this file." };
    }
    if (skipped.length > 0) {
      return {
        ok: false,
        message: `Import cancelled: fix the ${skipped.length} invalid row(s) before uploading again. No data was changed.`,
        details: skipped.map((s) => `Row ${s.row}: ${s.reason}`),
      };
    }
    const data = await postJson("/api/admin/concept-mappings/import", { mappings, externalRefs });
    const serverSkipped: { misconceptionId: string; conceptId: string; reason: string }[] = data.skipped ?? [];
    const details = [
      ...skipped.map((s) => `Row ${s.row}: ${s.reason}`),
      ...serverSkipped.map((s) => `${s.misconceptionId} -> ${s.conceptId}: ${s.reason}`),
    ];
    return {
      ok: true,
      message:
        `Imported mappings — ${data.mappings} mapping(s), ${data.externalRefs} external reference(s) saved.` +
        (details.length > 0 ? ` ${details.length} row(s) skipped.` : ""),
      details: details.length > 0 ? details : undefined,
    };
  } catch (error) {
    return describeError(error, "Failed to import mappings.");
  }
}
