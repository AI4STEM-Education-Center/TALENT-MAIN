import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import {
  getConsentExportSettings,
  updateConsentExportSettings,
  type ConsentExportSettingsValue,
} from "@/lib/consent-settings";

export const runtime = "nodejs";

export async function GET() {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;
  return NextResponse.json(await getConsentExportSettings());
}

const KEYS: (keyof ConsentExportSettingsValue)[] = [
  "maxEmailAttachmentBytes",
  "bulkExportBatchSize",
  "bulkExportInlineThreshold",
  "bulkExportMaxRecords",
  "bulkExportRetentionHours",
];

/** PATCH /api/admin/consent/settings — admin-configurable resource limits (see §8b of the plan). */
export async function PATCH(req: NextRequest) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const partial: Partial<ConsentExportSettingsValue> = {};
  for (const key of KEYS) {
    const value = body[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return NextResponse.json(
          { error: `${key} must be a number.` },
          { status: 400 },
        );
      }
      partial[key] = value;
    }
  }

  const updated = await updateConsentExportSettings(partial, session.user.id);
  return NextResponse.json(updated);
}
