import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  invalidateProviderCache,
  isThinkingLevel,
  resolveThinkingLevel,
  THINKING_LEVELS,
} from "@/lib/ai-provider";
import { logApiError } from "@/lib/system-log";

const VALID_USE_CASES = [
  "pdf_description",
  "description_generation",
  "recommendation",
  "quiz_extraction",
  "simulation_generation",
  "student_assistant",
  "teacher_assistant",
] as const;

/**
 * Move any leftover per-model thinking level onto the assignments that use the
 * model, then clear it. Thinking level used to be a per-model control; this is
 * the one-shot carry-over for configs saved before it moved to the use case.
 * Idempotent and self-terminating — once a model's legacy value is cleared it
 * is never seen again. Models with no assignment are left alone: their value
 * has nowhere to go yet, and `resolveThinkingLevel` still honours it if one of
 * them is assigned later (the next load of this page carries it over properly).
 */
async function carryOverLegacyThinkingLevels(): Promise<void> {
  const legacy = await prisma.aiModel.findMany({
    where: { thinkingLevel: { not: null }, assignments: { some: {} } },
    select: { id: true, thinkingLevel: true },
  });
  if (legacy.length === 0) return;

  await prisma.$transaction([
    // Only fill assignments that have no level of their own — an explicit
    // per-use-case choice always outranks the inherited one.
    ...legacy.map((m) =>
      prisma.aiUseCaseAssignment.updateMany({
        where: { modelId: m.id, thinkingLevel: null },
        data: { thinkingLevel: m.thinkingLevel },
      }),
    ),
    prisma.aiModel.updateMany({
      where: { id: { in: legacy.map((m) => m.id) } },
      data: { thinkingLevel: null },
    }),
  ]);

  invalidateProviderCache();
}

/**
 * GET /api/admin/ai-assignments
 * Return current use-case → provider+model+thinkingLevel mappings.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await carryOverLegacyThinkingLevels();

    const assignments = await prisma.aiUseCaseAssignment.findMany({
      include: {
        provider: {
          select: { id: true, name: true, providerType: true, isActive: true },
        },
        model: {
          select: {
            id: true,
            modelId: true,
            displayName: true,
            serviceTier: true,
            thinkingLevel: true,
          },
        },
      },
    });

    // Build a map of all use cases, filling in unassigned ones with null
    const assignmentMap: Record<string, unknown> = {};
    const assignmentByUseCase = new Map(assignments.map((a) => [a.useCase, a]));
    for (const uc of VALID_USE_CASES) {
      const assignment = assignmentByUseCase.get(uc);
      assignmentMap[uc] = assignment
        ? {
            id: assignment.id,
            providerId: assignment.providerId,
            providerName: assignment.provider.name,
            providerType: assignment.provider.providerType,
            providerActive: assignment.provider.isActive,
            modelId: assignment.modelId,
            modelIdentifier: assignment.model.modelId,
            modelDisplayName: assignment.model.displayName,
            serviceTier: assignment.model.serviceTier,
            thinkingLevel: resolveThinkingLevel(
              assignment.thinkingLevel,
              assignment.model.thinkingLevel,
            ),
          }
        : null;
    }

    return NextResponse.json({ assignments: assignmentMap });
  } catch (error) {
    logApiError("AI_ASSIGNMENTS_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/admin/ai-assignments
 * Update/upsert use case assignments.
 * Body: { assignments: { [useCase]: { providerId, modelId, thinkingLevel? } | null } }
 * Setting a use case to null removes its assignment. An omitted, empty or null
 * `thinkingLevel` means "send no reasoning_effort for this use case".
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const incoming = body?.assignments;

    if (!incoming || typeof incoming !== "object") {
      return NextResponse.json(
        { error: "Body must contain 'assignments' object" },
        { status: 400 },
      );
    }

    const results: Record<string, string> = {};

    for (const useCase of VALID_USE_CASES) {
      if (!(useCase in incoming)) continue;

      const assignment = incoming[useCase];

      // Null or empty → remove assignment
      if (!assignment) {
        await prisma.aiUseCaseAssignment.deleteMany({
          where: { useCase },
        });
        results[useCase] = "removed";
        continue;
      }

      const providerId =
        typeof assignment.providerId === "string"
          ? assignment.providerId.trim()
          : "";
      const modelId =
        typeof assignment.modelId === "string" ? assignment.modelId.trim() : "";

      if (!providerId || !modelId) {
        results[useCase] = "skipped (missing providerId or modelId)";
        continue;
      }

      // Unset is a real choice, not a missing field: it keeps `reasoning_effort`
      // off the wire entirely for models that would reject it.
      const rawLevel =
        typeof assignment.thinkingLevel === "string"
          ? assignment.thinkingLevel.trim()
          : "";
      const thinkingLevel = rawLevel || null;
      if (thinkingLevel && !isThinkingLevel(thinkingLevel)) {
        results[useCase] =
          `skipped (thinking level must be one of: ${THINKING_LEVELS.join(", ")}, or empty)`;
        continue;
      }

      // Validate that the provider and model exist
      const provider = await prisma.aiProvider.findUnique({
        where: { id: providerId },
      });
      if (!provider) {
        results[useCase] = "skipped (provider not found)";
        continue;
      }

      const model = await prisma.aiModel.findFirst({
        where: { id: modelId, providerId },
      });
      if (!model) {
        results[useCase] = "skipped (model not found for this provider)";
        continue;
      }

      await prisma.aiUseCaseAssignment.upsert({
        where: { useCase },
        update: { providerId, modelId, thinkingLevel },
        create: { useCase, providerId, modelId, thinkingLevel },
      });
      results[useCase] = "saved";
    }

    // Invalidate all cached providers
    invalidateProviderCache();

    return NextResponse.json({ results });
  } catch (error) {
    logApiError("AI_ASSIGNMENTS_PUT", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
