import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getStudentPause } from "@/lib/class-access-pause";

export async function GET() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STUDENT")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await getStudentPause(session.user.id), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
