import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/** Cap on rows returned for one lookup — an attempt has at most a handful. */
const MAX_ROWS = 50;

/**
 * GET /api/feedback/mine?attemptId=… | ?simulationId=…
 *
 * The caller's OWN verdicts, so a re-opened results page or simulation panel
 * shows the rating they already left instead of an empty form (submissions
 * upsert, so a blank form would invite an accidental overwrite).
 *
 * Deliberately self-scoped: it filters on the session's user id and never
 * takes an author from the query, which is what keeps it safe to expose to
 * students. Reading anyone ELSE's feedback is the consolidated panel's job,
 * behind /api/feedback/summary.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const attemptId = req.nextUrl.searchParams.get("attemptId")?.trim();
  const simulationId = req.nextUrl.searchParams.get("simulationId")?.trim();
  if (!attemptId && !simulationId) {
    return NextResponse.json(
      { error: "attemptId or simulationId is required" },
      { status: 400 },
    );
  }

  try {
    const rows = await prisma.contentFeedback.findMany({
      where: {
        authorUserId: session.user.id,
        ...(attemptId ? { attemptId } : {}),
        ...(simulationId
          ? { subjectType: "SIMULATION", subjectId: simulationId }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        subjectKey: true,
        subjectType: true,
        subjectId: true,
        subjectLabel: true,
        rating: true,
        comment: true,
        updatedAt: true,
      },
    });
    return NextResponse.json({ feedback: rows });
  } catch (error) {
    logApiError("CONTENT_FEEDBACK_MINE_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
