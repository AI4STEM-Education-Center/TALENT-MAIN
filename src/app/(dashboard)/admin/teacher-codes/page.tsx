import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TeacherCodesClient } from "./teacher-codes-client";

/**
 * Admin "Invite Codes" tab — issue, revoke and delete the registration codes
 * teachers and research scientists redeem at /register (the code's role decides
 * the account type). The path keeps its historical /teacher-codes name so
 * bookmarks keep working. The proxy already keeps non-admins out of
 * /admin/*, and /api/admin/teacher-codes re-checks the role on every request;
 * this server gate is the third layer, matching the other admin pages.
 */
export default async function AdminTeacherCodesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  return <TeacherCodesClient />;
}
