import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdminApi } from "@/lib/admin-access";
import { logApiError, logSystemEvent } from "@/lib/system-log";
import { getSttSettings, saveSttSettings } from "@/lib/stt/config";
import {
  AWS_TRANSCRIBE_STREAMING_REGIONS,
  STT_LANGUAGES,
  STT_PARTIAL_STABILITIES,
  STT_SURFACES,
} from "@/lib/stt/types";

export const runtime = "nodejs";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

interface SttLogMetadata {
  durationMs?: number;
  surface?: string;
  languageCode?: string;
  role?: string;
  userName?: string;
  userEmail?: string;
}

function parseSttMetadata(raw: string | null): SttLogMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SttLogMetadata;
  } catch {
    return {};
  }
}

/**
 * GET /api/admin/stt
 * Returns current STT settings, catalogs (languages, regions, stabilities),
 * and the STT usage log + per-user duration summary.
 */
export async function GET(req: NextRequest) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  try {
    const params = req.nextUrl.searchParams;
    const page = Math.max(1, Number(params.get("page")) || 1);
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Number(params.get("pageSize")) || PAGE_SIZE_DEFAULT),
    );
    const q = params.get("q")?.trim().toLowerCase() || "";

    const [settings, allLogs] = await Promise.all([
      getSttSettings(),
      prisma.systemLog.findMany({
        where: { category: "USAGE", type: "STT_SESSION" },
        orderBy: { createdAt: "desc" },
        take: 1000,
      }),
    ]);

    // Resolve live user names/emails for any userIds in the logs
    const userIds = [
      ...new Set(allLogs.map((l) => l.userId).filter((id): id is string => !!id)),
    ];
    const users =
      userIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          })
        : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = allLogs.map((log) => {
      const meta = parseSttMetadata(log.metadata);
      const user = log.userId ? userMap.get(log.userId) : undefined;
      const userName = user
        ? `${user.firstName} ${user.lastName}`.trim() || user.email
        : meta.userName || "(deleted user)";
      const userEmail = user?.email ?? meta.userEmail ?? "—";
      const role = user?.role ?? meta.role ?? "—";
      const durationMs =
        typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs)
          ? Math.max(0, meta.durationMs)
          : 0;
      const surface = meta.surface ?? "student_assistant";
      const languageCode = meta.languageCode ?? "en-US";

      return {
        id: log.id,
        createdAt: log.createdAt.toISOString(),
        userId: log.userId,
        userName,
        userEmail,
        role,
        durationMs,
        surface,
        languageCode,
      };
    });

    const filtered = q
      ? enriched.filter(
          (row) =>
            row.userName.toLowerCase().includes(q) ||
            row.userEmail.toLowerCase().includes(q) ||
            row.surface.toLowerCase().includes(q) ||
            row.role.toLowerCase().includes(q),
        )
      : enriched;

    // Aggregate per-user usage summary across all matching sessions
    const byUser = new Map<
      string,
      {
        userId: string;
        userName: string;
        userEmail: string;
        role: string;
        sessions: number;
        totalDurationMs: number;
        lastUsedAt: string;
      }
    >();

    let totalDurationMs = 0;
    for (const row of filtered) {
      totalDurationMs += row.durationMs;
      const key = row.userId ?? `${row.userEmail}:${row.userName}`;
      const existing = byUser.get(key);
      if (existing) {
        existing.sessions += 1;
        existing.totalDurationMs += row.durationMs;
        if (row.createdAt > existing.lastUsedAt) {
          existing.lastUsedAt = row.createdAt;
        }
      } else {
        byUser.set(key, {
          userId: key,
          userName: row.userName,
          userEmail: row.userEmail,
          role: row.role,
          sessions: 1,
          totalDurationMs: row.durationMs,
          lastUsedAt: row.createdAt,
        });
      }
    }

    const userSummaries = [...byUser.values()].sort(
      (a, b) => b.totalDurationMs - a.totalDurationMs,
    );

    const start = (page - 1) * pageSize;
    const logsPage = filtered.slice(start, start + pageSize);

    return NextResponse.json({
      settings,
      defaultRegion: process.env.AWS_REGION?.trim() || "us-east-1",
      catalogs: {
        languages: STT_LANGUAGES,
        regions: AWS_TRANSCRIBE_STREAMING_REGIONS,
        stabilities: STT_PARTIAL_STABILITIES,
        surfaces: STT_SURFACES,
      },
      usage: {
        totalSessions: filtered.length,
        totalDurationMs,
        uniqueUsers: userSummaries.length,
        userSummaries: userSummaries.slice(0, 50),
        logs: logsPage,
        page,
        pageSize,
      },
    });
  } catch (error) {
    logApiError("ADMIN_STT_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

const putSchema = z.object({
  enabled: z.boolean().optional(),
  region: z.string().max(40).optional(),
  languageCode: z.string().max(20).optional(),
  identifyLanguage: z.boolean().optional(),
  languageOptions: z.array(z.string().max(20)).max(10).optional(),
  enablePartialResultsStabilization: z.boolean().optional(),
  partialResultsStability: z.string().max(20).optional(),
});

/**
 * PUT /api/admin/stt
 * Updates the global STT settings in `AssistantConfig`.
 */
export async function PUT(req: Request) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  try {
    const body = await req.json().catch(() => null);
    const parsed = putSchema.safeParse(body?.settings ?? body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid STT settings payload." },
        { status: 400 },
      );
    }

    const settings = await saveSttSettings(parsed.data);

    void logSystemEvent({
      category: "SYSTEM",
      type: "ADMIN_STT_SETTINGS_UPDATED",
      severity: "INFO",
      userId: session.user.id,
      message: `Updated STT settings (enabled=${settings.enabled}, lang=${settings.languageCode}, identify=${settings.identifyLanguage})`,
      metadata: { settings },
    });

    return NextResponse.json({ settings });
  } catch (error) {
    logApiError("ADMIN_STT_PUT", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
