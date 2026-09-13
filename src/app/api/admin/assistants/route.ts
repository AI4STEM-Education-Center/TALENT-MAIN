import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import {
  getAssistantSettings,
  saveAssistantSettings,
  MAX_EXTRA_INSTRUCTIONS_CHARS,
  SETTINGS_BOUNDS,
} from "@/lib/assistant/config";
import { skillInfo } from "@/lib/assistant/skills";
import { allAttachmentKindInfo } from "@/lib/assistant/attachments";
import { ASSISTANT_AUDIENCES, AUDIENCE_USE_CASE, isAssistantAudience } from "@/lib/assistant/types";

export const runtime = "nodejs";

/**
 * GET /api/admin/assistants
 * Current settings for both assistants, plus the catalogs the form renders from
 * (registered skills per audience, registered attachment kinds, bounds). The
 * catalogs come from code, so adding a skill or an attachment kind shows up here
 * without a schema or UI change.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const assistants = await Promise.all(
      ASSISTANT_AUDIENCES.map(async (audience) => ({
        ...(await getAssistantSettings(audience)),
        useCase: AUDIENCE_USE_CASE[audience],
        availableSkills: skillInfo(audience),
      }))
    );

    return NextResponse.json({
      assistants,
      attachmentKinds: allAttachmentKindInfo(),
      bounds: SETTINGS_BOUNDS,
      maxExtraInstructionsChars: MAX_EXTRA_INSTRUCTIONS_CHARS,
    });
  } catch (error) {
    logApiError("ADMIN_ASSISTANTS_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

const patchSchema = z.object({
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

/**
 * PUT /api/admin/assistants
 * Body: { audience: "student" | "teacher", settings: { … } }
 * Unknown skill ids / attachment kinds are dropped and numbers are clamped by
 * saveAssistantSettings, so a partial or stale form submit still lands cleanly.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    if (!isAssistantAudience(body?.audience)) {
      return NextResponse.json(
        { error: `audience must be one of: ${ASSISTANT_AUDIENCES.join(", ")}` },
        { status: 400 }
      );
    }

    const parsed = patchSchema.safeParse(body.settings ?? {});
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid settings payload." }, { status: 400 });
    }

    // Loose strings are fine here: saveAssistantSettings reconciles the skill
    // ids, tool names and attachment kinds against the code registries and
    // clamps the numbers.
    const settings = await saveAssistantSettings(body.audience, parsed.data);

    return NextResponse.json({ settings });
  } catch (error) {
    logApiError("ADMIN_ASSISTANTS_PUT", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
