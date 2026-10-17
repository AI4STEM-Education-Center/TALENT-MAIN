import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { presignGetUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/admin/consent/export/:jobId
 * Status/progress poll for a bulk export job, and — once COMPLETE — a
 * short-lived presigned download URL. The admin's browser never buffers the
 * zip itself; it only ever follows this link.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const [session, { jobId }] = await Promise.all([requireAdminApi(), params]);
  if (session instanceof Response) return session;

  const job = await prisma.consentExportJob.findUnique({
    where: { id: jobId },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let downloadUrl: string | null = null;
  if (job.status === "COMPLETE" && job.resultBucket && job.resultKey) {
    downloadUrl = await presignGetUrl(job.resultBucket, job.resultKey, 3600);
  }

  return NextResponse.json({
    status: job.status,
    totalRecords: job.totalRecords,
    processedRecords: job.processedRecords,
    error: job.error,
    downloadUrl,
    expiresAt: job.expiresAt,
  });
}
