import * as archiverModule from "archiver";
import { Upload } from "@aws-sdk/lib-storage";
import { prisma } from "@/lib/prisma";
import { renderConsentPdf } from "@/lib/consent-pdf";
import { getConsentExportSettings } from "@/lib/consent-settings";
import {
  getS3Client,
  getS3Config,
  buildConsentExportKey,
  presignGetUrl,
  deleteS3Object,
} from "@/lib/storage";
import { sendEmail } from "@/lib/email";
import {
  isConsentDecision,
  isConsentRole,
  type ConsentDecision,
  type ConsentRole,
} from "@/lib/consent";

// @types/archiver@8 dropped the module's callable factory export from its
// declarations (it only types the Archiver class and options interfaces),
// even though the actual runtime package is `require("archiver")("zip", …)`.
// Typed narrowly here rather than fighting the incomplete community .d.ts.
type CreateArchive = (
  format: "zip",
  options?: { zlib?: { level?: number } },
) => archiverModule.Archiver;
const createArchive = archiverModule as unknown as CreateArchive;

/**
 * Bulk admin consent-PDF export, run ENTIRELY in the background worker — never
 * inline in a web request. See docs/plans/consent-compliance-plan.md §8.
 *
 * Two separate memory disciplines are at work here, both load-bearing:
 *  - Records are paged through in `bulkExportBatchSize`-sized batches (Prisma
 *    skip/take), so peak "how many ConsentRecord rows are in memory at once"
 *    stays bounded to one batch regardless of the export's total size.
 *  - The zip itself is built with `archiver` (a genuinely streaming zip
 *    encoder — each appended entry is compressed and flushed to the output
 *    stream as it's written, not buffered whole) piped directly into an
 *    `@aws-sdk/lib-storage` multipart S3 upload, so the compressed archive is
 *    never fully materialized in memory OR written to local disk. This is
 *    deliberately NOT built on jszip (used elsewhere in this repo, but only
 *    client-side): jszip's generate step compresses everything that was
 *    registered via `.file()`, so it does not give a true "add and flush"
 *    streaming guarantee the way `archiver` does.
 */

export interface ConsentExportFilter {
  recordIds?: string[];
  role?: ConsentRole;
  decision?: ConsentDecision;
  fromDate?: string; // ISO date, inclusive
  toDate?: string; // ISO date, inclusive
}

/** Shape-check a filter parsed from admin input before it's stored on a job. */
export function normalizeConsentExportFilter(
  raw: unknown,
): ConsentExportFilter | null {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const filter: ConsentExportFilter = {};

  if (input.recordIds !== undefined) {
    if (
      !Array.isArray(input.recordIds) ||
      !input.recordIds.every((v) => typeof v === "string")
    )
      return null;
    filter.recordIds = input.recordIds as string[];
  }
  if (input.role !== undefined) {
    if (!isConsentRole(input.role)) return null;
    filter.role = input.role;
  }
  if (input.decision !== undefined) {
    if (!isConsentDecision(input.decision)) return null;
    filter.decision = input.decision;
  }
  if (input.fromDate !== undefined) {
    if (
      typeof input.fromDate !== "string" ||
      Number.isNaN(Date.parse(input.fromDate))
    )
      return null;
    filter.fromDate = input.fromDate;
  }
  if (input.toDate !== undefined) {
    if (
      typeof input.toDate !== "string" ||
      Number.isNaN(Date.parse(input.toDate))
    )
      return null;
    filter.toDate = input.toDate;
  }
  return filter;
}

export function buildConsentRecordWhere(filter: ConsentExportFilter) {
  const where: Record<string, unknown> = {};
  if (filter.recordIds && filter.recordIds.length > 0)
    where.id = { in: filter.recordIds };
  if (filter.role) where.role = filter.role;
  if (filter.decision) where.decision = filter.decision;
  if (filter.fromDate || filter.toDate) {
    const signedAt: { gte?: Date; lte?: Date } = {};
    if (filter.fromDate) signedAt.gte = new Date(filter.fromDate);
    if (filter.toDate) signedAt.lte = new Date(filter.toDate);
    where.signedAt = signedAt;
  }
  return where;
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "record";
}

async function markFailed(jobId: string, error: string): Promise<void> {
  await prisma.consentExportJob
    .update({
      where: { id: jobId },
      data: { status: "FAILED", error, completedAt: new Date() },
    })
    .catch((err) =>
      console.error(`[ConsentExport] Could not mark job ${jobId} FAILED:`, err),
    );
}

/**
 * Run one bulk export job to completion. Idempotent-ish: re-running a job
 * that isn't still PENDING is a no-op, so a redelivered Honker job (e.g.
 * after a worker restart) can't double-process it. A job that dies mid-run
 * (worker crash) is left PROCESSING rather than retried automatically — see
 * the module-level note in src/worker.ts for why that's an acceptable
 * tradeoff for a feature this infrequently used.
 */
export async function runConsentExportJob(jobId: string): Promise<void> {
  const job = await prisma.consentExportJob.findUnique({
    where: { id: jobId },
  });
  if (!job || job.status !== "PENDING") return;

  await prisma.consentExportJob.update({
    where: { id: jobId },
    data: { status: "PROCESSING" },
  });

  const filter = normalizeConsentExportFilter(JSON.parse(job.filter));
  if (!filter) {
    await markFailed(jobId, "Malformed export filter.");
    return;
  }
  const where = buildConsentRecordWhere(filter);

  try {
    const totalRecords = await prisma.consentRecord.count({ where });
    await prisma.consentExportJob.update({
      where: { id: jobId },
      data: { totalRecords },
    });
    if (totalRecords === 0) {
      await markFailed(jobId, "No matching consent records were found.");
      return;
    }

    const settings = await getConsentExportSettings();
    if (totalRecords > settings.bulkExportMaxRecords) {
      await markFailed(
        jobId,
        `${totalRecords} records match, which exceeds the configured limit of ${settings.bulkExportMaxRecords}. Narrow the filter or raise the limit in Consent Settings.`,
      );
      return;
    }

    const { bucket } = getS3Config();
    const key = buildConsentExportKey(jobId);

    const archive = createArchive("zip", { zlib: { level: 6 } });
    const archiveFailure = new Promise<never>((_, reject) => {
      archive.on("error", reject);
      archive.on("warning", (warning: Error) =>
        console.warn(
          `[ConsentExport] archiver warning for job ${jobId}:`,
          warning,
        ),
      );
    });

    const upload = new Upload({
      client: getS3Client(),
      params: {
        Bucket: bucket,
        Key: key,
        Body: archive,
        ContentType: "application/zip",
      },
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
    });
    const uploadDone = upload.done();

    let processed = 0;
    let skip = 0;
    const seenNames = new Set<string>();
    for (;;) {
      const batch = await prisma.consentRecord.findMany({
        where,
        include: { formVersion: true },
        orderBy: { id: "asc" },
        skip,
        take: settings.bulkExportBatchSize,
      });
      if (batch.length === 0) break;
      skip += batch.length;

      // Sequential within a batch — pdf-lib's drawing work is CPU-bound and
      // parallelizing it wouldn't reduce total work on a single thread, only
      // raise peak memory by rendering several PDFs at once.
      for (const record of batch) {
        const pdf = await renderConsentPdf(record, record.formVersion);
        const base = `${record.role}_${sanitizeFilenamePart(record.signerNameSnapshot)}_${record.id.slice(0, 8)}.pdf`;
        let name = base;
        let suffix = 1;
        while (seenNames.has(name)) {
          name = `${base.replace(/\.pdf$/, "")}_${++suffix}.pdf`;
        }
        seenNames.add(name);
        archive.append(pdf, { name });
        processed++;
      }

      await prisma.consentExportJob.update({
        where: { id: jobId },
        data: { processedRecords: processed },
      });
      // Yield to the event loop between batches so other worker jobs (queued
      // emails, exam-result generation) sharing this process get a turn.
      await new Promise((resolve) => setImmediate(resolve));
    }

    await archive.finalize();
    await Promise.race([uploadDone, archiveFailure]);

    const expiresAt = new Date(
      Date.now() + settings.bulkExportRetentionHours * 60 * 60 * 1000,
    );
    await prisma.consentExportJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETE",
        completedAt: new Date(),
        resultBucket: bucket,
        resultKey: key,
        expiresAt,
      },
    });

    const admin = await prisma.user.findUnique({
      where: { id: job.requestedById },
      select: { email: true },
    });
    if (admin?.email) {
      try {
        const downloadUrl = await presignGetUrl(bucket, key, 24 * 3600);
        await sendEmail({
          to: [admin.email],
          subject: `Your consent export is ready (${processed} record${processed === 1 ? "" : "s"})`,
          text: [
            `Your bulk consent-record export finished processing ${processed} record(s).`,
            "",
            `Download it here (link expires in 24 hours): ${downloadUrl}`,
            "",
            `The file will be removed from storage after ${settings.bulkExportRetentionHours} hours; sign in to /admin/consent to request a new export after that.`,
          ].join("\n"),
        });
      } catch (err) {
        // Best-effort — the job is COMPLETE and the in-app admin UI can
        // surface a fresh download link regardless of whether this email sent.
        console.error(
          `[ConsentExport] Failed to email export-ready notice for job ${jobId}:`,
          err,
        );
      }
    }
  } catch (error) {
    console.error(`[ConsentExport] Job ${jobId} failed:`, error);
    await markFailed(
      jobId,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Delete expired export zips from S3 and clear their result pointers so the
 * admin UI stops offering a dead download link. Call periodically from the
 * worker (see src/worker.ts).
 */
export async function sweepExpiredConsentExports(limit = 50): Promise<number> {
  const expired = await prisma.consentExportJob.findMany({
    where: {
      status: "COMPLETE",
      expiresAt: { lt: new Date() },
      resultKey: { not: null },
    },
    select: { id: true, resultBucket: true, resultKey: true },
    take: limit,
  });
  if (expired.length === 0) return 0;

  let cleaned = 0;
  for (const job of expired) {
    try {
      if (job.resultBucket && job.resultKey)
        await deleteS3Object(job.resultBucket, job.resultKey);
      await prisma.consentExportJob.update({
        where: { id: job.id },
        data: { resultKey: null, resultBucket: null },
      });
      cleaned++;
    } catch (err) {
      console.error(
        `[ConsentExport] Failed to clean up expired export ${job.id}:`,
        err,
      );
    }
  }
  return cleaned;
}
