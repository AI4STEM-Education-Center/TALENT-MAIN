import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveConsentVersion } from "@/lib/consent";
import { ConsentRequiredClient, ConsentClaimSync } from "./consent-required-client";
import { sanitizeConsentHtml } from "@/lib/consent-html";

/**
 * Standalone route (deliberately OUTSIDE the (dashboard) route group — no
 * sidebar, no notifications badge, no other API dependencies) that
 * src/proxy.ts redirects an unconsented teacher to. Self-contained so it
 * keeps working even for a teacher whose every other /api/* call is being
 * blocked by that same gate.
 *
 * This page never server-redirects back to /teacher on a condition the proxy
 * cannot see for itself. The proxy decides from a JWT claim that only
 * refreshes at sign-in/update(); bouncing on fresher database state than the
 * claim has is exactly what produced ERR_TOO_MANY_REDIRECTS. Both such cases
 * (nothing published, or already agreed under a stale claim) instead render
 * ConsentClaimSync, which re-stamps the claim client-side and then leaves.
 */
export default async function TeacherConsentRequiredPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "TEACHER") {
    redirect(session.user.role === "ADMIN" ? "/admin" : "/student");
  }

  const activeForm = await getActiveConsentVersion("TEACHER");
  if (!activeForm) {
    // No instructor form published yet — there is nothing to enforce and
    // nothing to render, so refresh the claim (it becomes NOT_REQUIRED) and
    // hand them back to their dashboard.
    return <ConsentClaimSync reason="no-form" />;
  }

  const priorDecision = await prisma.consentRecord.findFirst({
    where: { userId: session.user.id, formVersionId: activeForm.id },
    orderBy: { signedAt: "desc" },
    select: { decision: true },
  });

  // A stale JWT is the only way to land here already agreed — refresh it
  // (a plain redirect would just bounce off the proxy again) and move on.
  if (priorDecision?.decision === "AGREE") return <ConsentClaimSync reason="already-agreed" />;

  return (
    <ConsentRequiredClient
      activeForm={{
        id: activeForm.id,
        title: activeForm.title,
        version: activeForm.version,
        bodyHtml: sanitizeConsentHtml(activeForm.bodyHtml),
      }}
      priorDecision={(priorDecision?.decision as "DECLINE" | undefined) ?? null}
    />
  );
}
