import { NextRequest, NextResponse } from "next/server";
import { requireAdminDataReader } from "@/lib/admin-access";
import {
  getReviewActor,
  listCoachReviewSessions,
} from "@/lib/wrong-answer-coach-review";
import { logApiError } from "@/lib/system-log";

export async function GET(req: NextRequest) {
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  const actor = await getReviewActor(session.user.id, session.user.role);
  if (!actor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const sp = req.nextUrl.searchParams;
    const data = await listCoachReviewSessions(actor, {
      flaggedOnly: sp.get("flaggedOnly") !== "false",
      reviewStatus: sp.get("reviewStatus"),
      classId: sp.get("classId"),
      quizId: sp.get("quizId"),
      diagnosis: sp.get("diagnosis"),
      flagType: sp.get("flagType"),
    });
    return NextResponse.json(data);
  } catch (err) {
    logApiError("ADMIN_COACH_REVIEWS_GET", err);
    return NextResponse.json(
      { error: "Failed to load coach review queue." },
      { status: 500 },
    );
  }
}
