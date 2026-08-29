import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TeacherCodesClient } from "./teacher-codes-client";

/**
 * Admin "Teacher Codes" tab — issue, revoke and delete the registration codes
 * teachers redeem at /register. The proxy already keeps non-admins out of
 * /admin/*, and /api/admin/teacher-codes re-checks the role on every request;
 * this server gate is the third layer, matching the other admin pages.
 */
export default async function AdminTeacherCodesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  return <TeacherCodesClient />;
}
