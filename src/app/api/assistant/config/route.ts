import { NextResponse } from "next/server";
import { resolveAssistantSession } from "@/lib/assistant/session";
import { attachmentKindInfo } from "@/lib/assistant/attachments";
import { greeting } from "@/lib/assistant/prompt";
import { resolveSkills } from "@/lib/assistant/skills";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * GET /api/assistant/config
 * What the chat widget needs to render itself: whether this user has an
 * assistant at all, and the input limits it must enforce client-side. Returns
 * `{ available: false }` — not a 403 — for admins and signed-out users, so the
 * widget can simply not mount.
 */
export async function GET() {
  try {
    const session = await resolveAssistantSession();
    if (!session || !session.settings.enabled) {
      return NextResponse.json({ available: false });
    }

    const { settings, ctx } = session;
    const { tools } = resolveSkills(
      ctx.audience,
      settings.enabledSkills,
      settings.disabledTools,
    );

    return NextResponse.json({
      available: true,
      audience: ctx.audience,
      greeting: greeting(ctx.audience),
      attachmentKinds: attachmentKindInfo(settings.attachmentKinds),
      maxAttachments: settings.maxAttachments,
      maxAttachmentBytes: settings.maxAttachmentBytes,
      attachmentRetentionDays: settings.attachmentRetentionDays,
      // Surfaced so the widget can tell the user what it can look up rather
      // than promising abilities the admin disabled.
      toolCount: tools.size,
    });
  } catch (error) {
    logApiError("ASSISTANT_CONFIG", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
