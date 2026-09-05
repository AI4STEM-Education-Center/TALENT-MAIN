import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  generatePressureToken,
  hashPressureToken,
  pressureTokenPrefix,
} from "@/lib/pressure-token";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });

const listSelect = {
  id: true,
  name: true,
  tokenPrefix: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
  revokedUseCount: true,
  lastRevokedUseAt: true,
  lastRevokedIp: true,
} as const;

/** Lists this deployment's ingestion tokens. Secrets are never returned. */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const tokens = await prisma.pressureResultToken.findMany({
      orderBy: { createdAt: "desc" },
      select: listSelect,
    });
    return NextResponse.json({ tokens });
  } catch (error) {
    logApiError("ADMIN_PRESSURE_TOKENS_GET", error);
    return NextResponse.json(
      { error: "Could not load ingestion tokens." },
      { status: 500 },
    );
  }
}

/**
 * Mints a token for this deployment. The plaintext is returned exactly once,
 * for the admin to paste into GitHub Actions secrets or `pressure/.env`; only
 * its digest is stored, so it cannot be shown again.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = createSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "A label of 1-80 characters is required." },
        { status: 400 },
      );
    }

    const token = generatePressureToken();
    const created = await prisma.pressureResultToken.create({
      data: {
        name: parsed.data.name,
        tokenHash: hashPressureToken(token),
        tokenPrefix: pressureTokenPrefix(token),
        createdById: session.user.id ?? null,
      },
      select: listSelect,
    });

    return NextResponse.json(
      { token: created, secret: token },
      { status: 201 },
    );
  } catch (error) {
    logApiError("ADMIN_PRESSURE_TOKENS_POST", error);
    return NextResponse.json(
      { error: "Could not create ingestion token." },
      { status: 500 },
    );
  }
}
