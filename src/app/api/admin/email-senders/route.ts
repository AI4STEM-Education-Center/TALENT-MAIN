import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  EMAIL_PURPOSES,
  EMAIL_PURPOSE_DEFINITIONS,
  isEmailPurpose,
  normalizeLocalPart,
  normalizeSenderDomain,
  isEmailAddress,
  resolveSenderIdentity,
  type EmailPurpose,
  type SenderOverride,
} from "@/lib/email-purposes";
import { parseBody, emailSendersUpdateSchema } from "@/lib/validation";
import { logApiError } from "@/lib/system-log";

/** The persisted shape of one override row (all fields explicit, no undefined). */
interface PersistedSender {
  localPart: string;
  fromName: string | null;
  replyTo: string | null;
  subject: string | null;
  body: string | null;
}

/**
 * Merge the catalog defaults with the admin's saved overrides so the UI always
 * renders a complete row per purpose, plus the address each one currently
 * sends from.
 */
async function buildPayload() {
  const [smtp, rows] = await Promise.all([
    prisma.smtpConfig.findFirst(),
    prisma.emailSender.findMany(),
  ]);

  const overrides = new Map<string, SenderOverride>(
    rows.map((r) => [
      r.purpose,
      {
        localPart: r.localPart,
        fromName: r.fromName,
        replyTo: r.replyTo,
        subject: r.subject,
        body: r.body,
      },
    ]),
  );

  const smtpView = {
    fromEmail: smtp?.fromEmail ?? "",
    fromName: smtp?.fromName ?? null,
    senderDomain: smtp?.senderDomain ?? null,
  };

  const senders = EMAIL_PURPOSES.map((purpose) => {
    const definition = EMAIL_PURPOSE_DEFINITIONS[purpose];
    const override = overrides.get(purpose) ?? null;
    return {
      purpose,
      label: definition.label,
      description: definition.description,
      defaultLocalPart: definition.defaultLocalPart,
      /** null when the body is written by a user rather than the app. */
      defaultTemplate: definition.template,
      variables: definition.variables,
      localPart: override?.localPart ?? definition.defaultLocalPart,
      fromName: override?.fromName ?? null,
      replyTo: override?.replyTo ?? null,
      subject: override?.subject ?? null,
      body: override?.body ?? null,
      resolved: resolveSenderIdentity(purpose, smtpView, override),
    };
  });

  return {
    senderDomain: smtpView.senderDomain,
    fallbackFromEmail: smtpView.fromEmail,
    smtpConfigured: !!smtp,
    senders,
  };
}

/** GET /api/admin/email-senders — per-purpose sender identities and templates. */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(await buildPayload());
}

/**
 * PUT /api/admin/email-senders — save the shared domain and per-purpose
 * overrides. Rows equal to the catalog default are still stored, so the saved
 * state matches exactly what the admin sees.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const parsed = parseBody(emailSendersUpdateSchema, await req.json());
    if (!parsed.ok) return parsed.response;
    const { senderDomain: rawDomain, senders } = parsed.data;

    let senderDomain: string | null = null;
    if (rawDomain) {
      senderDomain = normalizeSenderDomain(rawDomain);
      if (!senderDomain) {
        return NextResponse.json(
          {
            error: `"${rawDomain}" is not a valid domain. Use a bare hostname such as example.com.`,
          },
          { status: 400 },
        );
      }
      // The domain is a column on SmtpConfig, which only exists once the server
      // settings have been saved. Say so rather than dropping the input.
      if ((await prisma.smtpConfig.count()) === 0) {
        return NextResponse.json(
          {
            error:
              "Save the SMTP server settings above before setting a shared sender domain — " +
              "the domain is stored alongside them.",
          },
          { status: 400 },
        );
      }
    }

    // Validate every row before writing anything, so a single bad field can't
    // leave the table half-updated.
    const updates: { purpose: EmailPurpose; data: PersistedSender }[] = [];
    for (const row of senders) {
      if (!isEmailPurpose(row.purpose)) {
        return NextResponse.json(
          { error: `Unknown email purpose "${row.purpose}".` },
          { status: 400 },
        );
      }
      const definition = EMAIL_PURPOSE_DEFINITIONS[row.purpose];

      const localPart = row.localPart
        ? normalizeLocalPart(row.localPart)
        : definition.defaultLocalPart;
      if (!localPart) {
        return NextResponse.json(
          {
            error:
              `"${row.localPart}" is not a valid address prefix for ${definition.label}. ` +
              "Use letters, digits, dots, dashes or underscores.",
          },
          { status: 400 },
        );
      }

      if (row.replyTo && !isEmailAddress(row.replyTo)) {
        return NextResponse.json(
          {
            error: `"${row.replyTo}" is not a valid reply-to address for ${definition.label}.`,
          },
          { status: 400 },
        );
      }

      // Templates only exist for app-authored emails; ignore anything sent for
      // the purposes whose body comes from a teacher or student.
      const templated = definition.template !== null;

      updates.push({
        purpose: row.purpose,
        data: {
          localPart,
          fromName: row.fromName,
          replyTo: row.replyTo,
          subject: templated ? row.subject : null,
          body: templated ? row.body : null,
        },
      });
    }

    await prisma.$transaction([
      prisma.smtpConfig.updateMany({ data: { senderDomain } }),
      ...updates.map((u) =>
        prisma.emailSender.upsert({
          where: { purpose: u.purpose },
          create: { purpose: u.purpose, ...u.data },
          update: u.data,
        }),
      ),
    ]);

    return NextResponse.json(await buildPayload());
  } catch (error) {
    logApiError("ADMIN_EMAIL_SENDERS_PUT", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
