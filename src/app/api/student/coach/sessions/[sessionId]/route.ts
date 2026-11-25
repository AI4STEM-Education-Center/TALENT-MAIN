import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  CoachHttpError,
  getStudentCoachSession,
} from "@/lib/wrong-answer-coach-engine";
import { logApiError } from "@/lib/system-log";

export async function GET(
  _req: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId } = await context.params;
  try {
    const view = await getStudentCoachSession(sessionId, session.user.id);
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof CoachHttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logApiError("COACH_SESSION_GET", err);
    return NextResponse.json(
      { error: "Could not load coaching chat." },
      { status: 500 },
    );
  }
}
