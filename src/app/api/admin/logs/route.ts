import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

/**
 * Paginated system log feed for the admin UI, filterable by category/severity
 * plus a free-text search over message and type. Every response also carries a
 * 24h health summary (error/warning/failed-login counts and the latest traffic
 * sample) for the cards above the table.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = req.nextUrl.searchParams;
    const page = Math.max(1, Number(params.get("page")) || 1);
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Number(params.get("pageSize")) || PAGE_SIZE_DEFAULT)
    );
    const category = params.get("category") || undefined;
    const severity = params.get("severity") || undefined;
    const q = params.get("q")?.trim();

    const where = {
      ...(category ? { category } : {}),
      ...(severity ? { severity } : {}),
      ...(q
        ? {
            OR: [
              { message: { contains: q } },
              { type: { contains: q } },
              { ip: { contains: q } },
            ],
          }
        : {}),
    };

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [logs, total, errors24h, warnings24h, failedLogins24h, lastUsage] =
      await prisma.$transaction([
        prisma.systemLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.systemLog.count({ where }),
        prisma.systemLog.count({
          where: { severity: "ERROR", createdAt: { gte: dayAgo } },
        }),
        prisma.systemLog.count({
          where: { severity: "WARNING", createdAt: { gte: dayAgo } },
        }),
        prisma.systemLog.count({
          where: { type: "LOGIN_FAILED", createdAt: { gte: dayAgo } },
        }),
        prisma.systemLog.findFirst({
          where: { type: "USAGE_SAMPLE" },
          orderBy: { createdAt: "desc" },
        }),
      ]);

    return NextResponse.json({
      logs,
      total,
      page,
      pageSize,
      summary: { errors24h, warnings24h, failedLogins24h, lastUsage },
    });
  } catch (error) {
    logApiError("ADMIN_LOGS_GET", error);
    return NextResponse.json({ error: "Internal Error" }, { status: 500 });
  }
}
