import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
import { isModerationModel } from "@/lib/guardrail-fence";

export const runtime = "nodejs";

/**
 * Why an assigned moderation model cannot actually run, or null when it can.
 *
 * Checked from the assignment alone rather than by calling out, so the panel is
 * honest on load. It has to be said somewhere: moderation fails open by design,
 * so an assignment that can never work looks identical to one that never finds
 * anything — the check silently does nothing while the panel shows it enabled.
 */
function moderationWarning(
  providerType: string,
  modelId: string,
): string | null {
  if (providerType === "cloudflare") {
    return (
      "Cloudflare AI Gateway's compatibility endpoint does not implement " +
      "/v1/moderations, so this check cannot run. Assign an OpenAI provider " +
      "with omni-moderation-latest, or untick the box above."
    );
  }
  if (!isModerationModel(modelId)) {
    return (
      `${modelId} is a chat model. /v1/moderations only accepts a moderation ` +
      "model such as omni-moderation-latest, so this check cannot run."
    );
  }
  return null;
}

/**
 * Which model each guardrail check is currently running on.
 *
 * Read-only: the assignments themselves are edited in the use-case table at the
 * top of the AI Config page, which is the one place any use case is assigned.
 * The panel shows this so an admin tuning thresholds can see what is answering
 * them — and whether the two LLM checks share a model, which decides whether a
 * submission costs one call or two.
 */
async function guardrailModels() {
  const useCases = [
    "moderation",
    "guardrail_jailbreak",
    "guardrail_offtopic",
  ] as const;
  const rows = await prisma.aiUseCaseAssignment.findMany({
    where: { useCase: { in: [...useCases] } },
    include: {
      provider: { select: { name: true, isActive: true, providerType: true } },
      model: { select: { modelId: true, displayName: true } },
    },
  });

  const byUseCase = new Map(rows.map((row) => [row.useCase, row]));
  const summary: Record<
    string,
    { label: string; providerActive: boolean; warning: string | null } | null
  > = {};
  for (const useCase of useCases) {
    const row = byUseCase.get(useCase);
    summary[useCase] = row
      ? {
          label: `${row.provider.name} — ${row.model.displayName || row.model.modelId}`,
          providerActive: row.provider.isActive,
          warning:
            useCase === "moderation"
              ? moderationWarning(row.provider.providerType, row.model.modelId)
              : null,
        }
      : null;
  }

  const jailbreak = byUseCase.get("guardrail_jailbreak");
  const offTopic = byUseCase.get("guardrail_offtopic");

  return {
    models: summary,
    // Same provider AND model AND reasoning effort → the two questions ride in
    // one call. Mirrors providerKey() in src/lib/guardrails.ts.
    sharesOneCall: Boolean(
      jailbreak &&
      offTopic &&
      jailbreak.providerId === offTopic.providerId &&
      jailbreak.modelId === offTopic.modelId &&
      jailbreak.thinkingLevel === offTopic.thinkingLevel,
    ),
  };
}

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
      ...(await guardrailModels()),
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
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
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
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json({ settings: await saveGuardrailSettings(body) });
  } catch (error) {
    logApiError("ADMIN_GUARDRAILS", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
