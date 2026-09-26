import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadResearchPool } from "@/lib/research-email-server";
import { buildPoolCsv, csvFilename } from "@/lib/survey-csv";

export const runtime = "nodejs";

/**
 * GET /api/admin/research-pool — everyone who agreed to be contacted, via the
 * IRB consent form or the pre-survey's interview opt-in. `?format=csv` for a
 * download.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entries = await loadResearchPool();
  if (req.nextUrl.searchParams.get("format") === "csv") {
    return new NextResponse(`﻿${buildPoolCsv(entries)}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename("research pool")}"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json({ entries });
}
