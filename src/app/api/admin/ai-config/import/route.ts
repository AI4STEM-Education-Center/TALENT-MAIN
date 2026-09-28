import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  applyAiConfigImport,
  parseAiConfigBundle,
} from "@/lib/ai-config-transfer";
import { logApiError, logSystemEvent } from "@/lib/system-log";

export const runtime = "nodejs";

const optionsSchema = z.object({
  providers: z.array(z.string()).max(100).optional(),
  useCases: z.array(z.string()).max(100).optional(),
  assistants: z.boolean().default(false),
  guardrails: z.boolean().default(false),
  replaceExisting: z.boolean().default(false),
});

/**
 * POST /api/admin/ai-config/import
 * Body: { bundle: <export file>, options: { providers?, useCases?, assistants,
 *         guardrails, replaceExisting } }
 * `providers` holds `${providerType}:${name}` keys and `useCases` use-case
 * names; omitting either imports everything of that kind. `replaceExisting`
 * deletes every current provider, model and assignment first.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { bundle?: unknown; options?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = parseAiConfigBundle(body?.bundle);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const options = optionsSchema.safeParse(body?.options ?? {});
  if (!options.success) {
    return NextResponse.json(
      { error: "Invalid import options." },
      { status: 400 },
    );
  }

  try {
    const report = await applyAiConfigImport(parsed.bundle, options.data);

    void logSystemEvent({
      category: "API",
      type: "AI_CONFIG_IMPORT",
      message: `AI config imported (${report.providers.length} provider(s), ${report.useCases.length} use case(s)${options.data.replaceExisting ? ", replaced existing" : ""})`,
      userId: session.user.id,
      metadata: { report },
    });

    return NextResponse.json({ report });
  } catch (error) {
    logApiError("AI_CONFIG_IMPORT", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
