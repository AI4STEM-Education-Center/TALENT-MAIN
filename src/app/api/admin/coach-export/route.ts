import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildCoachResearchExport,
  getCoachExportSummary,
  serializeCoachExportCsv,
} from "@/lib/wrong-answer-coach-export";
import { logApiError, logSystemEvent } from "@/lib/system-log";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateBound(
  raw: string | null,
  endOfDayExclusive: boolean,
): { ok: true; date: Date | null } | { ok: false } {
  if (!raw || !raw.trim()) return { ok: true, date: null };
  const trimmed = raw.trim();
  if (DATE_ONLY_RE.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return { ok: false };
    if (endOfDayExclusive) {
      parsed.setUTCDate(parsed.getUTCDate() + 1);
    }
    return { ok: true, date: parsed };
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return { ok: false };
  if (endOfDayExclusive) {
    parsed.setUTCMilliseconds(parsed.getUTCMilliseconds() + 1);
  }
  return { ok: true, date: parsed };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") || "summary";
  if (!["summary", "jsonl", "csv"].includes(format)) {
    return NextResponse.json(
      { error: "Invalid format. Expected summary, jsonl, or csv." },
      { status: 400 },
    );
  }

  const fromParsed = parseDateBound(sp.get("from"), false);
  const toParsed = parseDateBound(sp.get("to"), true);
  if (!fromParsed.ok || !toParsed.ok) {
    return NextResponse.json(
      {
        error: "Invalid date parameter. Expected ISO-8601 date or YYYY-MM-DD.",
      },
      { status: 400 },
    );
  }

  const redaction = sp.get("redaction") === "raw_irb" ? "raw_irb" : "redacted";
  const classId = sp.get("classId") || null;
  const quizId = sp.get("quizId") || null;
  const includeIncomplete = sp.get("includeIncomplete") === "true";

  try {
    if (format === "summary") {
      const [summary, classes] = await Promise.all([
        getCoachExportSummary({
          classId,
          quizId,
          from: fromParsed.date,
          toExclusive: toParsed.date,
          includeIncomplete,
        }),
        prisma.class.findMany({
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        }),
      ]);
      return NextResponse.json(
        {
          totalMatchingSessions: summary.totalMatchingSessions,
          consentingExportableSessions: summary.consentingExportableSessions,
          excludedNonConsentingSessions: Math.max(
            0,
            summary.totalMatchingSessions -
              summary.consentingExportableSessions,
          ),
          classes,
        },
        {
          headers: { "Cache-Control": "no-store, private" },
        },
      );
    }

    const result = await buildCoachResearchExport({
      classId,
      quizId,
      from: fromParsed.date,
      toExclusive: toParsed.date,
      includeIncomplete,
      redaction,
    });

    await logSystemEvent({
      category: "SYSTEM",
      type: "COACH_RESEARCH_EXPORT_DOWNLOAD",
      severity: "INFO",
      message: `Admin exported ${result.exportedCount} consenting Wrong Answer Coach sessions (${format}, ${redaction}).`,
      userId: session.user.id,
      metadata: {
        format,
        redaction,
        classId,
        quizId,
        includeIncomplete,
        exportedCount: result.exportedCount,
        totalMatchingSessions: result.totalMatchingSessions,
      },
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "csv") {
      const csv = serializeCoachExportCsv(result.records);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="wrong-answer-coach-${redaction}-${timestamp}.csv"`,
          "Cache-Control": "no-store, private",
        },
      });
    }

    const jsonl =
      result.records.map((r) => JSON.stringify(r)).join("\n") +
      (result.records.length > 0 ? "\n" : "");
    return new NextResponse(jsonl, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="wrong-answer-coach-${redaction}-${timestamp}.jsonl"`,
        "Cache-Control": "no-store, private",
      },
    });
  } catch (err) {
    logApiError("ADMIN_COACH_EXPORT_GET", err);
    return NextResponse.json(
      { error: "Failed to build coach research export." },
      { status: 500 },
    );
  }
}
