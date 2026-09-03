import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPressureToken } from "@/lib/pressure-token";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 512 * 1024;

class BodyTooLargeError extends Error {}

async function readLimitedBody(request: NextRequest): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLargeError();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const resultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).max(160),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  environment: z.string().min(1).max(40),
  suite: z.string().min(1).max(80),
  scenario: z.string().min(1).max(100),
  status: z.enum(["PASS", "FAIL"]),
  source: z.string().min(1).max(80),
  commitSha: z.string().max(80).nullable().optional(),
  branch: z.string().max(200).nullable().optional(),
  targetUrl: z.url().max(500).nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  totalChecks: z.number().int().nonnegative().default(0),
  passedChecks: z.number().int().nonnegative().default(0),
  failedChecks: z.number().int().nonnegative().default(0),
  latency: z
    .object({
      p50Ms: z.number().nonnegative().nullable().optional(),
      p95Ms: z.number().nonnegative().nullable().optional(),
      p99Ms: z.number().nonnegative().nullable().optional(),
      maxMs: z.number().nonnegative().nullable().optional(),
    })
    .default({}),
  requestRate: z.number().nonnegative().nullable().optional(),
  virtualUsers: z.number().int().nonnegative().nullable().optional(),
  errorRate: z.number().min(0).max(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  metrics: z.record(z.string(), z.unknown()).default({}),
  failures: z.array(z.unknown()).max(500).default([]),
});

/**
 * Authenticated machine-to-machine ingestion used by GitHub and local runs.
 * The accepted tokens are the ones an admin minted in this deployment's own
 * web UI, so dev and production each authorize themselves with no shared
 * secret and no server environment variable.
 */
export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip")?.trim() ||
      null;
    if (!(await verifyPressureToken(request.headers.get("authorization"), { ip }))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let raw: string;
    try {
      raw = await readLimitedBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return NextResponse.json({ error: "Result exceeds 512 KiB." }, { status: 413 });
      }
      throw error;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const parsed = resultSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid pressure-test result.", issues: parsed.error.issues.slice(0, 10) },
        { status: 400 }
      );
    }

    const result = parsed.data;
    const data = {
      startedAt: new Date(result.startedAt),
      finishedAt: new Date(result.finishedAt),
      environment: result.environment,
      suite: result.suite,
      scenario: result.scenario,
      status: result.status,
      source: result.source,
      commitSha: result.commitSha ?? null,
      branch: result.branch ?? null,
      targetUrl: result.targetUrl ?? null,
      durationMs: result.durationMs,
      totalChecks: result.totalChecks,
      passedChecks: result.passedChecks,
      failedChecks: result.failedChecks,
      p50Ms: result.latency.p50Ms ?? null,
      p95Ms: result.latency.p95Ms ?? null,
      p99Ms: result.latency.p99Ms ?? null,
      maxMs: result.latency.maxMs ?? null,
      requestRate: result.requestRate ?? null,
      virtualUsers: result.virtualUsers ?? null,
      errorRate: result.errorRate ?? null,
      metadata: JSON.stringify(result.metadata),
      metrics: JSON.stringify(result.metrics),
      failures: JSON.stringify(result.failures),
    };

    const stored = await prisma.pressureTestResult.upsert({
      where: { runId: result.runId },
      create: { runId: result.runId, ...data },
      update: data,
      select: { id: true, runId: true, createdAt: true },
    });

    return NextResponse.json({ stored }, { status: 201 });
  } catch (error) {
    logApiError("PRESSURE_RESULT_POST", error);
    return NextResponse.json({ error: "Could not store result." }, { status: 500 });
  }
}
