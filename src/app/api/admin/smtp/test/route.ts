import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  getSmtpConfig,
  verifyAndTest,
  type ResolvedSmtpConfig,
} from "@/lib/email";

/**
 * POST /api/admin/smtp/test
 * Verify SMTP connectivity and optionally send a test email.
 * Body: { to?: string } — when provided, a test email is sent to this address.
 * Uses the currently-saved SMTP config.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await getSmtpConfig();
  if (!cfg) {
    return NextResponse.json(
      {
        error: "No SMTP server is configured yet. Save a configuration first.",
      },
      { status: 400 },
    );
  }

  let to: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.to === "string" && body.to.trim()) to = body.to.trim();
  } catch {
    // empty body is fine — connection-only test
  }

  // verifyAndTest uses the saved password; cfg already has it decrypted.
  const resolved: ResolvedSmtpConfig = cfg;

  try {
    await verifyAndTest(resolved, to);
    return NextResponse.json({
      success: true,
      message: to
        ? `Test email sent to ${to}.`
        : "Connected to the SMTP server successfully.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `SMTP test failed: ${message}` },
      { status: 400 },
    );
  }
}
