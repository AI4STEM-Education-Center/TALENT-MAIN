import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateProviderCache, THINKING_LEVELS, isThinkingLevel } from "@/lib/ai-provider";
import { logApiError } from "@/lib/system-log";

/**
 * GET /api/admin/ai-providers/[id]/models
 * List all models for a given provider.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const provider = await prisma.aiProvider.findUnique({ where: { id } });
    if (!provider) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    const models = await prisma.aiModel.findMany({
      where: { providerId: id },
      orderBy: { modelId: "asc" },
    });

    return NextResponse.json({
      models: models.map((m) => ({
        id: m.id,
        modelId: m.modelId,
        displayName: m.displayName,
        serviceTier: m.serviceTier,
        thinkingLevel: m.thinkingLevel,
        isDefault: m.isDefault,
      })),
    });
  } catch (error) {
    logApiError("AI_MODELS_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/admin/ai-providers/[id]/models
 * Add a model to a provider.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const provider = await prisma.aiProvider.findUnique({ where: { id } });
    if (!provider) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    const body = await req.json();
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() || null : null;
    const serviceTier = typeof body.serviceTier === "string" ? body.serviceTier.trim() || null : null;
    const thinkingLevel =
      typeof body.thinkingLevel === "string" ? body.thinkingLevel.trim() || null : null;
    const isDefault = body.isDefault === true;

    if (!modelId) {
      return NextResponse.json({ error: "Model ID is required" }, { status: 400 });
    }

    // Validate service tier
    if (serviceTier && !["flex", "auto", "default"].includes(serviceTier)) {
      return NextResponse.json(
        { error: "Service tier must be 'flex', 'auto', 'default', or empty" },
        { status: 400 }
      );
    }

    // Thinking level is optional and never inferred from the model id: an unset
    // level means the request omits `reasoning_effort` entirely, which is what
    // keeps non-reasoning models working.
    if (thinkingLevel && !isThinkingLevel(thinkingLevel)) {
      return NextResponse.json(
        { error: `Thinking level must be one of: ${THINKING_LEVELS.join(", ")}, or empty` },
        { status: 400 }
      );
    }

    // If this model should be default, unset all other defaults for this provider
    if (isDefault) {
      await prisma.aiModel.updateMany({
        where: { providerId: id, isDefault: true },
        data: { isDefault: false },
      });
    }

    const model = await prisma.aiModel.create({
      data: {
        providerId: id,
        modelId,
        displayName,
        serviceTier,
        thinkingLevel,
        isDefault,
      },
    });

    invalidateProviderCache();

    return NextResponse.json({
      model: {
        id: model.id,
        modelId: model.modelId,
        displayName: model.displayName,
        serviceTier: model.serviceTier,
        thinkingLevel: model.thinkingLevel,
        isDefault: model.isDefault,
      },
    }, { status: 201 });
  } catch (error: any) {
    // Handle unique constraint violation
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: "This model ID already exists for this provider" },
        { status: 409 }
      );
    }

    logApiError("AI_MODELS_POST", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/ai-providers/[id]/models
 * Update an existing model's editable fields.
 * Body: { id: <model record ID>, modelId?, displayName?, serviceTier?, thinkingLevel?, isDefault? }
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: providerId } = await params;

  try {
    const body = await req.json();
    const recordId = typeof body.id === "string" ? body.id.trim() : "";

    if (!recordId) {
      return NextResponse.json({ error: "Model record ID is required" }, { status: 400 });
    }

    const existing = await prisma.aiModel.findFirst({
      where: { id: recordId, providerId },
    });
    if (!existing) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }

    const data: {
      modelId?: string;
      displayName?: string | null;
      serviceTier?: string | null;
      thinkingLevel?: string | null;
      isDefault?: boolean;
    } = {};

    if (body.modelId !== undefined) {
      const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      if (!modelId) {
        return NextResponse.json({ error: "Model ID cannot be empty" }, { status: 400 });
      }
      data.modelId = modelId;
    }

    if (body.displayName !== undefined) {
      data.displayName =
        typeof body.displayName === "string" && body.displayName.trim()
          ? body.displayName.trim()
          : null;
    }

    if (body.serviceTier !== undefined) {
      const serviceTier =
        typeof body.serviceTier === "string" && body.serviceTier.trim()
          ? body.serviceTier.trim()
          : null;
      if (serviceTier && !["flex", "auto", "default"].includes(serviceTier)) {
        return NextResponse.json(
          { error: "Service tier must be 'flex', 'auto', 'default', or empty" },
          { status: 400 }
        );
      }
      data.serviceTier = serviceTier;
    }

    if (body.thinkingLevel !== undefined) {
      const thinkingLevel =
        typeof body.thinkingLevel === "string" && body.thinkingLevel.trim()
          ? body.thinkingLevel.trim()
          : null;
      if (thinkingLevel && !isThinkingLevel(thinkingLevel)) {
        return NextResponse.json(
          { error: `Thinking level must be one of: ${THINKING_LEVELS.join(", ")}, or empty` },
          { status: 400 }
        );
      }
      data.thinkingLevel = thinkingLevel;
    }

    if (body.isDefault !== undefined) {
      data.isDefault = body.isDefault === true;
    }

    // If this model is being set as default, unset any other default for this provider.
    if (data.isDefault === true) {
      await prisma.aiModel.updateMany({
        where: { providerId, isDefault: true, NOT: { id: recordId } },
        data: { isDefault: false },
      });
    }

    const model = await prisma.aiModel.update({
      where: { id: recordId },
      data,
    });

    invalidateProviderCache();

    return NextResponse.json({
      model: {
        id: model.id,
        modelId: model.modelId,
        displayName: model.displayName,
        serviceTier: model.serviceTier,
        thinkingLevel: model.thinkingLevel,
        isDefault: model.isDefault,
      },
    });
  } catch (error: any) {
    if (error?.code === "P2002") {
      return NextResponse.json(
        { error: "A model with this ID, service tier, and thinking level already exists for this provider" },
        { status: 409 }
      );
    }

    logApiError("AI_MODELS_PATCH", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/ai-providers/[id]/models
 * Delete a model by its model record ID (sent in body).
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: providerId } = await params;

  try {
    const body = await req.json();
    const modelRecordId = typeof body.modelId === "string" ? body.modelId.trim() : "";

    if (!modelRecordId) {
      return NextResponse.json({ error: "Model record ID is required" }, { status: 400 });
    }

    const model = await prisma.aiModel.findFirst({
      where: { id: modelRecordId, providerId },
    });

    if (!model) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }

    await prisma.aiModel.delete({ where: { id: modelRecordId } });

    invalidateProviderCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    logApiError("AI_MODELS_DELETE", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
