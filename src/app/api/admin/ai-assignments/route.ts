import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateProviderCache } from "@/lib/ai-provider";

const VALID_USE_CASES = ["teacher_chat", "student_chat", "pdf_description"] as const;

/**
 * GET /api/admin/ai-assignments
 * Return current use-case → provider+model mappings.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const assignments = await prisma.aiUseCaseAssignment.findMany({
      include: {
        provider: {
          select: { id: true, name: true, providerType: true, isActive: true },
        },
        model: {
          select: { id: true, modelId: true, displayName: true, serviceTier: true },
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
          }
        : null;
    }

    return NextResponse.json({ assignments: assignmentMap });
  } catch (error) {
    console.error("[AI_ASSIGNMENTS_GET]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PUT /api/admin/ai-assignments
 * Update/upsert use case assignments.
 * Body: { assignments: { [useCase]: { providerId, modelId } | null } }
 * Setting a use case to null removes its assignment.
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
        { status: 400 }
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
        typeof assignment.modelId === "string"
          ? assignment.modelId.trim()
          : "";

      if (!providerId || !modelId) {
        results[useCase] = "skipped (missing providerId or modelId)";
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
        update: { providerId, modelId },
        create: { useCase, providerId, modelId },
      });
      results[useCase] = "saved";
    }

    // Invalidate all cached providers
    invalidateProviderCache();

    return NextResponse.json({ results });
  } catch (error) {
    console.error("[AI_ASSIGNMENTS_PUT]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
