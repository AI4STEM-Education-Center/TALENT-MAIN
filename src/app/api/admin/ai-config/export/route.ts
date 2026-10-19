import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { buildAiConfigExport } from "@/lib/ai-config-transfer";
import { logApiError, logSystemEvent } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * GET /api/admin/ai-config/export
 * Download the whole AI configuration — providers with their API keys in
 * plaintext, models, use-case assignments, assistant and guardrail settings —
 * as one JSON file for /api/admin/ai-config/import on another site.
 */
export async function GET() {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  try {
    const bundle = await buildAiConfigExport();

    // The file carries plaintext keys, so who took one is worth a log line.
    void logSystemEvent({
      category: "API",
      type: "AI_CONFIG_EXPORT",
      message: `AI config exported (${bundle.providers.length} provider(s))`,
      userId: session.user.id,
    });

    const stamp = bundle.exportedAt?.slice(0, 10) ?? "export";
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="ai-config-${stamp}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    logApiError("AI_CONFIG_EXPORT", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
