import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appOrigin } from "@/lib/app-url";
import { createTeacherCode, toTeacherCodeView } from "@/lib/teacher-registration-codes";
import {
  MAX_EXPIRES_IN_MINUTES,
  MAX_USES_LIMIT,
  MIN_EXPIRES_IN_MINUTES,
} from "@/lib/teacher-codes";
import { parseBody, teacherCodeCreateSchema } from "@/lib/validation";
import { logApiError, logSystemEvent } from "@/lib/system-log";

export const runtime = "nodejs";

/** How many codes the panel lists. Revoked ones are kept as an audit record. */
const LIST_LIMIT = 200;

/**
 * GET /api/admin/teacher-codes — every issued teacher registration code,
 * newest first, plus whether the legacy TEACHER_SIGNUP_TOKEN env var is still
 * accepted alongside them.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const rows = await prisma.teacherRegistrationCode.findMany({
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    });
    const origin = appOrigin(req);
    const now = new Date();

    return NextResponse.json({
      codes: rows.map((row) => toTeacherCodeView(row, origin, now)),
      // The panel warns about this: while it is set, that one value registers
      // teachers forever regardless of what is revoked here.
      envTokenActive: !!process.env.TEACHER_SIGNUP_TOKEN,
    });
  } catch (error) {
    logApiError("ADMIN_TEACHER_CODES_GET", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

/** POST /api/admin/teacher-codes — mint a code with its own expiry and use limit. */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const parsed = parseBody(teacherCodeCreateSchema, await req.json());
    if (!parsed.ok) return parsed.response;
    const { label, expiresInMinutes, maxUses } = parsed.data;

    // Ranges are checked here rather than in the zod schema so the admin sees
    // which bound they crossed instead of parseBody's uniform 400 text.
    if (
      expiresInMinutes !== null &&
      (expiresInMinutes < MIN_EXPIRES_IN_MINUTES || expiresInMinutes > MAX_EXPIRES_IN_MINUTES)
    ) {
      return NextResponse.json(
        {
          error:
            `A code must last between ${MIN_EXPIRES_IN_MINUTES} minutes and ` +
            `${Math.round(MAX_EXPIRES_IN_MINUTES / (365 * 24 * 60))} years, ` +
            "or leave the duration empty for a code that never expires.",
        },
        { status: 400 }
      );
    }
    if (maxUses !== null && (maxUses < 1 || maxUses > MAX_USES_LIMIT)) {
      return NextResponse.json(
        {
          error:
            `The use limit must be between 1 and ${MAX_USES_LIMIT}, ` +
            "or empty for unlimited registrations.",
        },
        { status: 400 }
      );
    }

    const row = await createTeacherCode({
      label,
      expiresInMinutes,
      maxUses,
      createdById: session.user.id,
    });

    void logSystemEvent({
      category: "AUTH",
      type: "TEACHER_CODE_CREATED",
      message: `Teacher registration code issued${label ? ` (${label})` : ""}.`,
      userId: session.user.id,
      // Never the code itself — the admin log is readable by every admin and
      // the code is a bearer credential.
      metadata: { codeId: row.id, expiresAt: row.expiresAt, maxUses: row.maxUses },
    });

    return NextResponse.json(toTeacherCodeView(row, appOrigin(req)), { status: 201 });
  } catch (error) {
    logApiError("ADMIN_TEACHER_CODES_POST", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
