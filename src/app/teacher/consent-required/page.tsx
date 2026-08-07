import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveConsentVersion } from "@/lib/consent";
import { ConsentRequiredClient } from "./consent-required-client";

/**
 * Standalone route (deliberately OUTSIDE the (dashboard) route group — no
 * sidebar, no notifications badge, no other API dependencies) that
 * src/proxy.ts redirects an unconsented teacher to. Self-contained so it
 * keeps working even for a teacher whose every other /api/* call is being
 * blocked by that same gate.
 */
export default async function TeacherConsentRequiredPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "TEACHER") {
    redirect(session.user.role === "ADMIN" ? "/admin" : "/student");
  }

  const activeForm = await getActiveConsentVersion("TEACHER");
  if (!activeForm) {
    // Misconfigured deployment (no form published yet) — nothing to enforce.
    redirect("/teacher");
  }

  const priorDecision = await prisma.consentRecord.findFirst({
    where: { userId: session.user.id, formVersionId: activeForm.id },
    orderBy: { signedAt: "desc" },
    select: { decision: true },
  });

  // A stale JWT is the only way to land here already agreed — send them on.
  if (priorDecision?.decision === "AGREE") redirect("/teacher");

  return (
    <ConsentRequiredClient
      activeForm={{
        id: activeForm.id,
        title: activeForm.title,
        version: activeForm.version,
        bodyHtml: activeForm.bodyHtml,
      }}
      priorDecision={(priorDecision?.decision as "DECLINE" | undefined) ?? null}
    />
  );
}
