import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";

const PAGE_SIZE_MAX = 100;

function parseJson(value: string, fallback: unknown) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Admin history with server-side filtering and compact chart data. */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = request.nextUrl.searchParams;
    const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Number.parseInt(params.get("pageSize") ?? "25", 10) || 25)
    );
    const days = Math.min(365, Math.max(1, Number.parseInt(params.get("days") ?? "30", 10) || 30));
    const suite = params.get("suite") || undefined;
    const scenario = params.get("scenario") || undefined;
    const status = params.get("status") || undefined;
    const environment = params.get("environment") || undefined;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where = {
      createdAt: { gte: from },
      ...(suite ? { suite } : {}),
      ...(scenario ? { scenario } : {}),
      ...(status ? { status } : {}),
      ...(environment ? { environment } : {}),
    };

    const [rows, total, facets] = await prisma.$transaction([
      prisma.pressureTestResult.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.pressureTestResult.count({ where }),
      prisma.pressureTestResult.findMany({
        where: { createdAt: { gte: from } },
        select: { suite: true, scenario: true, environment: true },
        distinct: ["suite", "scenario", "environment"],
      }),
    ]);

    const results = rows.map((row) => ({
      ...row,
      metadata: parseJson(row.metadata, {}),
      metrics: parseJson(row.metrics, {}),
      failures: parseJson(row.failures, []),
    }));
    return NextResponse.json({
      results,
      total,
      page,
      pageSize,
      facets: {
        suites: [...new Set(facets.map((row) => row.suite))].sort(),
        scenarios: [...new Set(facets.map((row) => row.scenario))].sort(),
        environments: [...new Set(facets.map((row) => row.environment))].sort(),
      },
    });
  } catch (error) {
    logApiError("ADMIN_PRESSURE_RESULTS_GET", error);
    return NextResponse.json({ error: "Could not load pressure-test history." }, { status: 500 });
  }
}
