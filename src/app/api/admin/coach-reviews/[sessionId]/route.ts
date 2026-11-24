import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  getCoachReviewDetail,
  getReviewActor,
  submitCoachReviewDecision,
} from "@/lib/wrong-answer-coach-review";
import { COACH_REVIEW_DECISIONS } from "@/lib/wrong-answer-coach-types";
import { logApiError } from "@/lib/system-log";

const reviewPatchSchema = z.object({
  reviewDecision: z.enum(COACH_REVIEW_DECISIONS),
  reviewOverrideCode: z.string().trim().max(40).nullable().optional(),
  reviewNotes: z.string().max(2_000).nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actor = await getReviewActor(session.user.id, session.user.role);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await context.params;
  try {
    const detail = await getCoachReviewDetail(actor, sessionId);
    if (!detail) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ session: detail });
  } catch (err) {
    logApiError("ADMIN_COACH_REVIEW_DETAIL_GET", err);
    return NextResponse.json(
      { error: "Failed to load session detail." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const actor = await getReviewActor(session.user.id, session.user.role);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = reviewPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid review decision payload." },
      { status: 400 },
    );
  }

  const { sessionId } = await context.params;
  try {
    const res = await submitCoachReviewDecision(actor, sessionId, parsed.data);
    if (!res.ok) {
      return NextResponse.json({ error: res.error }, { status: res.status });
    }
    const detail = await getCoachReviewDetail(actor, sessionId);
    return NextResponse.json({ ok: true, session: detail });
  } catch (err) {
    logApiError("ADMIN_COACH_REVIEW_PATCH", err);
    return NextResponse.json(
      { error: "Failed to save review decision." },
      { status: 500 },
    );
  }
}
