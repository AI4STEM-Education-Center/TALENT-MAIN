import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isConsentRole } from "@/lib/consent";
import { sanitizeConsentHtml } from "@/lib/consent-html";
import { OFFICIAL_CONSENT_FORMS } from "@/lib/consent-form-templates";

export const runtime = "nodejs";

/**
 * Returns every published version plus the IRB-approved text this build ships
 * (src/lib/consent-form-templates.ts), so an admin can publish the official
 * form from the UI without pasting HTML — the same text `npm run seed:consent`
 * installs. Sent alongside the list rather than from its own endpoint: the
 * publish screen needs both together and nothing else consumes it.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const versions = await prisma.consentFormVersion.findMany({
    orderBy: [{ role: "asc" }, { createdAt: "desc" }],
    select: { id: true, role: true, version: true, title: true, isActive: true, createdAt: true },
  });
  return NextResponse.json({ versions, official: OFFICIAL_CONSENT_FORMS });
}

/**
 * POST /api/admin/consent/forms
 * Publishes a new form version for a role — versions are append-only (never
 * edited in place), so every past signature always points at an immutable
 * record of exactly what text was agreed to. Publishing deactivates the
 * previous active version for the same role and, from that point on,
 * re-triggers the consent gate for everyone on that role (their stored
 * decision no longer matches the new active version).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { role?: unknown; version?: unknown; title?: unknown; bodyHtml?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const role = isConsentRole(body.role) ? body.role : null;
  const version = typeof body.version === "string" ? body.version.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const rawBodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.trim() : "";

  if (!role) return NextResponse.json({ error: "A valid role (STUDENT or TEACHER) is required." }, { status: 400 });
  if (!version || version.length > 40) {
    return NextResponse.json({ error: "A version label (1-40 characters) is required." }, { status: 400 });
  }
  if (!title || title.length > 300) {
    return NextResponse.json({ error: "A title (1-300 characters) is required." }, { status: 400 });
  }
  if (!rawBodyHtml || rawBodyHtml.length > 200_000) {
    return NextResponse.json({ error: "Form text is required and must be under 200,000 characters." }, { status: 400 });
  }
  const bodyHtml = sanitizeConsentHtml(rawBodyHtml);
  if (!bodyHtml.replace(/<[^>]*>/g, "").trim()) {
    return NextResponse.json({ error: "Form text must contain readable content." }, { status: 400 });
  }

  const existing = await prisma.consentFormVersion.findUnique({ where: { role_version: { role, version } } });
  if (existing) {
    return NextResponse.json({ error: `Version "${version}" already exists for ${role}.` }, { status: 409 });
  }

  const [, created] = await prisma.$transaction([
    prisma.consentFormVersion.updateMany({ where: { role, isActive: true }, data: { isActive: false } }),
    prisma.consentFormVersion.create({
      data: { role, version, title, bodyHtml, isActive: true, createdById: session.user.id },
    }),
  ]);

  return NextResponse.json({ version: created }, { status: 201 });
}
