import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import {
  getGuardrailSettings,
  saveGuardrailSettings,
  GUARDRAIL_SURFACES,
  GUARDRAIL_SURFACE_LABELS,
  MAX_TOPIC_DESCRIPTION_CHARS,
  THRESHOLD_BOUNDS,
} from "@/lib/guardrail-settings";
import { DEFAULT_TOPIC_DESCRIPTION } from "@/lib/guardrail-check";

export const runtime = "nodejs";

/**
 * GET /api/admin/guardrails
 * Current guardrail settings plus the catalogs the form renders from. The
 * surface list comes from code, so guarding a new surface shows up here without
 * a schema or UI change.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json({
      settings: await getGuardrailSettings(),
      surfaces: GUARDRAIL_SURFACES.map((surface) => ({
        key: surface,
        label: GUARDRAIL_SURFACE_LABELS[surface],
      })),
      defaultTopicDescription: DEFAULT_TOPIC_DESCRIPTION,
      maxTopicDescriptionChars: MAX_TOPIC_DESCRIPTION_CHARS,
      thresholdBounds: THRESHOLD_BOUNDS,
    });
  } catch (error) {
    logApiError("ADMIN_GUARDRAILS", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PUT /api/admin/guardrails
 * Save the settings. Every field is normalized and bounded server-side rather
 * than trusted from the form, so a modified request cannot put the checks into
 * a state the UI would not allow. Saving invalidates both the settings cache
 * and every verdict cached under the previous policy.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  try {
    return NextResponse.json({ settings: await saveGuardrailSettings(body) });
  } catch (error) {
    logApiError("ADMIN_GUARDRAILS", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
