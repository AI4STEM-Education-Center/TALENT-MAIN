import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { appOrigin } from "@/lib/app-url";
import {
  getSenderOverride,
  sendEmailToRecipient,
  SmtpNotConfiguredError,
} from "@/lib/email";
import {
  APP_NAME,
  isEmailAddress,
  renderPurposeMessage,
} from "@/lib/email-purposes";
import { getS3Object } from "@/lib/storage";
import { renderResearchEmail, type EmailVariant } from "@/lib/research-email";
import { parseResearchEmailInput } from "@/lib/research-email-input";
import { errorMessage } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/admin/research-email/test { ...email, to } — send both versions to
 * one address, with sample values, exactly as a recipient would get them
 * (reply-to and attachments included).
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "research-email-test", 10, 60_000);
  if (limited) return limited;
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!isEmailAddress(to))
    return NextResponse.json(
      { error: "Enter a valid test address." },
      { status: 400 },
    );
  const parsed = parseResearchEmailInput(body, true);
  if (!parsed.ok)
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  const email = parsed.value;

  const sample = {
    name: `${session.user.firstName} ${session.user.lastName}`.trim(),
    firstName: session.user.firstName,
    lastName: session.user.lastName,
    role: "Student",
    appName: APP_NAME,
    surveyLink: `${appOrigin(req)}/survey/example-link`,
  };
  const variants: Array<{
    variant: EmailVariant;
    vars: Record<string, string>;
  }> = [
    {
      variant: "IRB",
      vars: {
        ...sample,
        agreedPlace: "the IRB consent form",
        consentLevel: "Interview with audio-only recording",
      },
    },
    {
      variant: "SURVEY",
      vars: { ...sample, agreedPlace: "the pre-survey", consentLevel: "" },
    },
  ];

  try {
    const [override, attachments] = await Promise.all([
      getSenderOverride("RESEARCH"),
      Promise.all(
        email.attachments.map(async (a) => {
          const obj = await getS3Object(a.bucket, a.key);
          return {
            filename: a.name,
            content: Buffer.from(obj.body),
            contentType: a.contentType,
          };
        }),
      ),
    ]);
    for (const { variant, vars } of variants) {
      const content = renderResearchEmail(email, variant, vars);
      const message = renderPurposeMessage(
        "RESEARCH",
        { appName: APP_NAME, subject: content.subject, body: content.text },
        override,
      );
      await sendEmailToRecipient({
        to,
        subject: `[Test — ${variant === "IRB" ? "IRB" : "Survey"} version] ${message.subject}`,
        text: message.text,
        replyTo: email.replyTo,
        purpose: "RESEARCH",
        attachments,
      });
    }
  } catch (error) {
    const status = error instanceof SmtpNotConfiguredError ? 409 : 502;
    return NextResponse.json({ error: errorMessage(error) }, { status });
  }
  return NextResponse.json({ ok: true });
}
