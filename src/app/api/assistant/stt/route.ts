import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAssistantSettings } from "@/lib/assistant/config";
import { checkRateLimit, clientIp, rateLimit } from "@/lib/rate-limit";
import { logApiError, logSystemEvent } from "@/lib/system-log";
import { getSttSettings } from "@/lib/stt/config";
import { presignTranscribeStreamingUrl } from "@/lib/stt/transcribe-presign";
import {
  isSttLanguageCode,
  isSttSurface,
  type SttSurface,
} from "@/lib/stt/types";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const MAX_DURATION_MS = 30 * 60 * 1_000; // cap single reported session at 30 min

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("presign"),
    surface: z.string().max(50).optional(),
  }),
  z.object({
    action: z.literal("complete"),
    surface: z.string().max(50).optional(),
    durationMs: z.number().int().min(0).max(MAX_DURATION_MS),
    languageCode: z.string().max(20).optional(),
  }),
]);

async function authorizeCaller(surface: SttSurface): Promise<
  | {
      userId: string;
      role: string;
      userName: string;
      userEmail: string;
    }
  | Response
> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      role: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify the corresponding assistant surface is enabled for this caller's role.
  if (user.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!student) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const assistant = await getAssistantSettings("student");
    if (!assistant.enabled) {
      return NextResponse.json(
        { error: "The student assistant is currently disabled." },
        { status: 503 },
      );
    }
  } else if (user.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!teacher) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const targetAudience =
      surface === "simulation_editor" ? "simulation" : "teacher";
    const assistant = await getAssistantSettings(targetAudience);
    if (!assistant.enabled) {
      return NextResponse.json(
        { error: "The assistant is currently disabled." },
        { status: 503 },
      );
    }
  } else if (user.role === "ADMIN") {
    // Admins can use simulation editor or test STT when enabled.
    if (surface === "simulation_editor") {
      const assistant = await getAssistantSettings("simulation");
      if (!assistant.enabled) {
        return NextResponse.json(
          { error: "The simulation assistant is currently disabled." },
          { status: 503 },
        );
      }
    }
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return {
    userId: user.id,
    role: user.role,
    userName: `${user.firstName} ${user.lastName}`.trim() || user.email,
    userEmail: user.email,
  };
}

/**
 * POST /api/assistant/stt
 *
 * - `action: "presign"`: Validates authentication, role authorization, STT
 *   enablement, and rate limits, then generates a short-lived SigV4-presigned
 *   Amazon Transcribe Streaming WebSocket URL. The signed URL is never logged
 *   or persisted.
 * - `action: "complete"`: Records the completed session duration in `SystemLog`
 *   (`category: "USAGE"`, `type: "STT_SESSION"`) so administrators can inspect
 *   who used voice input and for how long in the admin panel.
 */
export async function POST(req: Request) {
  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = requestSchema.safeParse(
      rawBody && typeof rawBody === "object" && !("action" in rawBody)
        ? { action: "presign", ...rawBody }
        : rawBody,
    );

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid STT request payload." },
        { status: 400 },
      );
    }

    const body = parsed.data;
    const surface: SttSurface = isSttSurface(body.surface)
      ? body.surface
      : "student_assistant";

    const caller = await authorizeCaller(surface);
    if (caller instanceof Response) return caller;

    const sttSettings = await getSttSettings();
    if (!sttSettings.enabled) {
      return NextResponse.json(
        { error: "Voice input is disabled by the administrator." },
        { status: 503 },
      );
    }

    if (body.action === "complete") {
      const throttled = rateLimit(
        req,
        "assistant-stt-complete",
        120,
        HOUR_MS,
        caller.userId,
      );
      if (throttled) return throttled;

      const durationSec = Math.round((body.durationMs / 1000) * 10) / 10;
      const lang = isSttLanguageCode(body.languageCode)
        ? body.languageCode
        : sttSettings.languageCode;

      await logSystemEvent({
        category: "USAGE",
        type: "STT_SESSION",
        severity: "INFO",
        userId: caller.userId,
        ip: clientIp(req),
        message: `${caller.userName} (${caller.role.toLowerCase()}) used voice input for ${durationSec}s on ${surface}`,
        metadata: {
          durationMs: body.durationMs,
          surface,
          languageCode: lang,
          role: caller.role,
          userName: caller.userName,
          userEmail: caller.userEmail,
        },
      });

      return NextResponse.json({ ok: true });
    }

    // `action === "presign"`: enforce both a burst limit (10/min) and hourly limit (60/hr)
    // Always check in-process rate limits when not in test mode.
    const burstLimited = rateLimit(
      req,
      "assistant-stt-burst",
      10,
      MINUTE_MS,
      caller.userId,
    );
    if (burstLimited) return burstLimited;

    const hourlyLimited = rateLimit(
      req,
      "assistant-stt-hourly",
      60,
      HOUR_MS,
      caller.userId,
    );
    if (hourlyLimited) return hourlyLimited;

    // Also expose a testable rate-limit hook when x-enforce-stt-limit header is set in tests
    if (
      process.env.NODE_ENV === "test" &&
      req.headers.get("x-test-rate-limit") === "1"
    ) {
      const check = checkRateLimit(`test-stt:${caller.userId}`, 2, MINUTE_MS);
      if (!check.allowed) {
        return NextResponse.json(
          { error: "Too many voice input requests. Please wait a moment." },
          { status: 429 },
        );
      }
    }

    const presigned = presignTranscribeStreamingUrl({
      settings: sttSettings,
    });

    return NextResponse.json(presigned, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    logApiError("ASSISTANT_STT", error);
    const message =
      error instanceof Error &&
      (error.message.includes("AWS_") ||
        error.message.includes("Transcribe") ||
        error.message.includes("region"))
        ? error.message
        : "Could not start voice transcription.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
