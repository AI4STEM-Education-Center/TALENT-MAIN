import { prisma } from "@/lib/prisma";
import { InviteClient, type InviteInfo } from "./invite-client";

// Public page: validate the invite token on the server (no API round-trip) and
// hand the result to the client component, which owns the interactive
// verify/sign-up/join flow. Mirrors GET /api/invitations/[token].
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { class: { include: { teacher: { include: { user: true } } } } },
  });

  let info: InviteInfo | null = null;
  let error = "";
  if (!invitation) {
    error = "Invalid invitation link.";
  } else if (!invitation.active) {
    error = "This invitation link has been deactivated.";
  } else if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    error = "This invitation link has expired.";
  } else if (invitation.maxUses && invitation.usedCount >= invitation.maxUses) {
    error = "This invitation link has reached its maximum uses.";
  } else {
    info = {
      valid: true,
      classId: invitation.classId,
      className: invitation.class.name,
      teacherName: `${invitation.class.teacher.user.firstName} ${invitation.class.teacher.user.lastName}`,
    };
  }

  return <InviteClient token={token} info={info} initialError={error} />;
}
