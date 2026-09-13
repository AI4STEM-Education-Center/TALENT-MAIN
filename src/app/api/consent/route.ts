import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { parseBody, consentSubmitSchema } from "@/lib/validation";
import {
  getActiveConsentVersion,
  isConsentRole,
  normalizeStrokeData,
  parseDeviceType,
} from "@/lib/consent";
import { enqueueConsentConfirmationEmail } from "@/lib/consent-email";
import { enqueueConsentEmails } from "@/lib/queue";
import { sanitizeConsentHtml } from "@/lib/consent-html";

export const runtime = "nodejs";

/**
 * GET /api/consent
 * Always a fresh database read (never trusts the session JWT's consent
 * claim) — the client-side ConsentGate calls this on every dashboard page
 * load specifically so a newly-published form version is picked up within
 * the same session, rather than waiting for the JWT to refresh at next
 * sign-in. See src/lib/consent.ts for why the JWT claim itself stays
 * eventually-consistent.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  if (!isConsentRole(role)) {
    return NextResponse.json({
      needsDecision: false,
      role: null,
      activeForm: null,
      priorDecision: null,
    });
  }

  const activeForm = await getActiveConsentVersion(role);
  if (!activeForm) {
    // No form published yet for this role — nothing to enforce (misconfigured
    // deployment, not a reason to lock anyone out).
    return NextResponse.json({
      needsDecision: false,
      role,
      activeForm: null,
      priorDecision: null,
    });
  }

  const priorDecision = await prisma.consentRecord.findFirst({
    where: { userId: session.user.id, formVersionId: activeForm.id },
    orderBy: { signedAt: "desc" },
    select: {
      decision: true,
      signedAt: true,
      interviewRecordingConsent: true,
      signatureTypedName: true,
    },
  });

  return NextResponse.json({
    needsDecision: !priorDecision,
    role,
    activeForm: {
      id: activeForm.id,
      title: activeForm.title,
      version: activeForm.version,
      bodyHtml: sanitizeConsentHtml(activeForm.bodyHtml),
    },
    priorDecision: priorDecision ?? null,
  });
}

/**
 * POST /api/consent
 * Records (or re-records, if the user is revisiting their decision) the
 * signed-in user's decision on the currently active form for their role.
 * IP/device are always derived server-side — never trusted from the client —
 * for the audit record (see docs/plans/consent-compliance-plan.md §1/§10).
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "consent-submit", 10, 60_000);
  if (limited) return limited;

  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = session.user.role;
  if (!isConsentRole(role)) {
    return NextResponse.json(
      { error: "This account type does not use a consent form." },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBody(consentSubmitSchema, raw);
  if (!parsed.ok) return parsed.response;
  const { decision, interviewRecordingConsent, signatureTypedName } =
    parsed.data;

  if (interviewRecordingConsent && !parsed.data.initialsStrokeData) {
    return NextResponse.json(
      {
        error: "Draw your initials to consent to the interview being recorded.",
      },
      { status: 400 },
    );
  }

  const activeForm = await getActiveConsentVersion(role);
  if (!activeForm) {
    return NextResponse.json(
      {
        error: "No consent form is currently published for your account type.",
      },
      { status: 409 },
    );
  }

  let initialsStrokeData: string | null;
  let signatureStrokeData: string | null;
  try {
    initialsStrokeData = normalizeStrokeData(parsed.data.initialsStrokeData);
    signatureStrokeData = normalizeStrokeData(parsed.data.signatureStrokeData);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Invalid signature data.",
      },
      { status: 400 },
    );
  }

  const userAgent = req.headers.get("user-agent") ?? "";
  const record = await prisma.consentRecord.create({
    data: {
      userId: session.user.id,
      role,
      formVersionId: activeForm.id,
      decision,
      interviewRecordingConsent: interviewRecordingConsent ?? null,
      initialsStrokeData,
      signatureTypedName: signatureTypedName.trim(),
      signatureStrokeData,
      ipAddress: clientIp(req),
      userAgent,
      deviceType: parseDeviceType(userAgent),
      signerNameSnapshot:
        `${session.user.firstName} ${session.user.lastName}`.trim(),
      signerEmailSnapshot: session.user.email,
    },
  });

  // Best-effort — a queue hiccup must never fail the signature itself; the
  // decision is already durably recorded above.
  try {
    const deliveryId = await enqueueConsentConfirmationEmail(
      record.id,
      session.user.email,
    );
    enqueueConsentEmails([deliveryId]);
  } catch (error) {
    console.error("[Consent] Failed to enqueue confirmation email:", error);
    await prisma.consentRecord
      .update({
        where: { id: record.id },
        data: {
          emailStatus: "FAILED",
          emailError:
            error instanceof Error
              ? error.message.slice(0, 300)
              : "Could not queue delivery",
        },
      })
      .catch((auditError) =>
        console.error(
          "[Consent] Failed to update email audit status:",
          auditError,
        ),
      );
  }

  return NextResponse.json({
    ok: true,
    decision,
    formVersion: activeForm.version,
  });
}
