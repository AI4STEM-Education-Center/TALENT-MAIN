import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getConsentExportSettings,
  updateConsentExportSettings,
  type ConsentExportSettingsValue,
} from "@/lib/consent-settings";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
        return NextResponse.json({ error: `${key} must be a number.` }, { status: 400 });
      }
      partial[key] = value;
    }
  }

  const updated = await updateConsentExportSettings(partial, session.user.id);
  return NextResponse.json(updated);
}
