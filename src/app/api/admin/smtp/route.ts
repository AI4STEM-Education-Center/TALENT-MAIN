import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";
import { logApiError } from "@/lib/system-log";

const SINGLETON_ID = "singleton";

/**
 * GET /api/admin/smtp
 * Return the singleton SMTP config (password masked). Returns null when unset.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await prisma.smtpConfig.findFirst();
  if (!cfg) return NextResponse.json({ config: null });

  let maskedPassword: string | null = null;
  if (cfg.passwordEnc && cfg.passwordIv && cfg.passwordTag) {
    try {
      maskedPassword = maskApiKey(
        decryptApiKey(cfg.passwordEnc, cfg.passwordIv, cfg.passwordTag),
      );
    } catch {
      maskedPassword = "••••(decryption failed)";
    }
  }

  return NextResponse.json({
    config: {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      username: cfg.username,
      hasPassword: !!cfg.passwordEnc,
      maskedPassword,
      fromEmail: cfg.fromEmail,
      fromName: cfg.fromName,
      isActive: cfg.isActive,
      updatedAt: cfg.updatedAt,
    },
  });
}

/**
 * PUT /api/admin/smtp
 * Upsert the singleton SMTP config. A password sent as the masked placeholder
 * ("••••…") is left unchanged; an empty string clears it.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();

    const host = typeof body.host === "string" ? body.host.trim() : "";
    const portRaw = Number(body.port);
    const port =
      Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 587;
    const secure = body.secure === true;
    const username =
      typeof body.username === "string" ? body.username.trim() || null : null;
    const fromEmail =
      typeof body.fromEmail === "string" ? body.fromEmail.trim() : "";
    const fromName =
      typeof body.fromName === "string" ? body.fromName.trim() || null : null;
    const isActive = body.isActive === true;

    if (!host) {
      return NextResponse.json(
        { error: "SMTP host is required." },
        { status: 400 },
      );
    }
    if (!fromEmail) {
      return NextResponse.json(
        { error: "From email address is required." },
        { status: 400 },
      );
    }

    const existing = await prisma.smtpConfig.findFirst();

    // Resolve password encryption fields.
    let passwordFields:
      | {
          passwordEnc: string | null;
          passwordIv: string | null;
          passwordTag: string | null;
        }
      | undefined;
    if (typeof body.password === "string") {
      const raw = body.password.trim();
      if (raw && !raw.startsWith("••••")) {
        const enc = encryptApiKey(raw);
        passwordFields = {
          passwordEnc: enc.encrypted,
          passwordIv: enc.iv,
          passwordTag: enc.tag,
        };
      } else if (raw === "") {
        passwordFields = {
          passwordEnc: null,
          passwordIv: null,
          passwordTag: null,
        };
      }
      // masked placeholder → leave unchanged (passwordFields stays undefined)
    }

    const baseData = {
      host,
      port,
      secure,
      username,
      fromEmail,
      fromName,
      isActive,
      ...(passwordFields ?? {}),
    };

    const cfg = existing
      ? await prisma.smtpConfig.update({
          where: { id: existing.id },
          data: baseData,
        })
      : await prisma.smtpConfig.create({
          data: { id: SINGLETON_ID, ...baseData },
        });

    return NextResponse.json({
      config: {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        username: cfg.username,
        hasPassword: !!cfg.passwordEnc,
        fromEmail: cfg.fromEmail,
        fromName: cfg.fromName,
        isActive: cfg.isActive,
        updatedAt: cfg.updatedAt,
      },
    });
  } catch (error) {
    logApiError("SMTP_PUT", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
