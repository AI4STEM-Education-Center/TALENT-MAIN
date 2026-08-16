import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeConsentExportFilter, buildConsentRecordWhere } from "@/lib/consent-export";
import { getConsentExportSettings } from "@/lib/consent-settings";
import { enqueueConsentExport } from "@/lib/queue";

export const runtime = "nodejs";

/**
 * POST /api/admin/consent/export
 * Creates a ConsentExportJob and wakes the worker to process it. Deliberately
 * does NOT generate anything itself — see docs/plans/consent-compliance-plan.md
 * §8 for why bulk PDF/zip generation always runs in the background worker,
 * never inline in a request handler.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const filter = normalizeConsentExportFilter((raw as { filter?: unknown } | null)?.filter ?? {});
  if (!filter) return NextResponse.json({ error: "Invalid export filter." }, { status: 400 });

  const [settings, matchCount] = await Promise.all([
    getConsentExportSettings(),
    prisma.consentRecord.count({ where: buildConsentRecordWhere(filter) }),
  ]);
  if (matchCount === 0) {
    return NextResponse.json({ error: "No consent records match that filter." }, { status: 400 });
  }
  if (matchCount > settings.bulkExportMaxRecords) {
    return NextResponse.json(
      {
        error: `${matchCount} records match, which exceeds the configured limit of ${settings.bulkExportMaxRecords}. Narrow the filter or raise the limit in Consent Settings.`,
      },
      { status: 400 }
    );
  }

  const job = await prisma.consentExportJob.create({
    data: {
      requestedById: session.user.id,
      filter: JSON.stringify(filter),
      totalRecords: matchCount,
    },
  });

  try {
    enqueueConsentExport(job.id);
  } catch (error) {
    await prisma.consentExportJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: "Could not enqueue the export job." },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not enqueue the export job." },
      { status: 500 }
    );
  }

  return NextResponse.json({ jobId: job.id, totalRecords: matchCount }, { status: 201 });
}
