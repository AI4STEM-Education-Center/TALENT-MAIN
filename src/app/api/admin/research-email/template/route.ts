import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_RESEARCH_EMAIL_CONTENT,
  isResearchEmailKind,
  normalizePoolAudience,
  normalizePostSurveyAudience,
  parseAttachments,
} from "@/lib/research-email";
import { parseResearchEmailInput } from "@/lib/research-email-input";

export const runtime = "nodejs";

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** GET /api/admin/research-email/template?kind=POOL|POST_SURVEY — the saved draft. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const kind = req.nextUrl.searchParams.get("kind");
  if (!isResearchEmailKind(kind))
    return NextResponse.json({ error: "Unknown email type." }, { status: 400 });

  const row = await prisma.researchEmailTemplate.findUnique({
    where: { kind },
  });
  const defaults = DEFAULT_RESEARCH_EMAIL_CONTENT[kind];
  const audience = parseJson(row?.audience ?? "{}");
  return NextResponse.json({
    kind,
    replyTo: row?.replyTo ?? "",
    irbSubject: row?.irbSubject || defaults.irbSubject,
    irbBody: row?.irbBody || defaults.irbBody,
    surveySubject: row?.surveySubject || defaults.surveySubject,
    surveyBody: row?.surveyBody || defaults.surveyBody,
    attachments: parseAttachments(row?.attachments),
    audience:
      kind === "POOL"
        ? normalizePoolAudience(audience)
        : normalizePostSurveyAudience(audience),
    updatedAt: row?.updatedAt ?? null,
  });
}

/** PUT — save the draft (lenient: an unfinished draft is fine to keep). */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseResearchEmailInput(body, false);
  if (!parsed.ok)
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { kind, attachments, ...rest } = parsed.value;
  const data = {
    ...rest,
    attachments: JSON.stringify(attachments),
    updatedById: session.user.id,
  };
  await prisma.researchEmailTemplate.upsert({
    where: { kind },
    create: { kind, ...data },
    update: data,
  });
  return NextResponse.json({ ok: true });
}
