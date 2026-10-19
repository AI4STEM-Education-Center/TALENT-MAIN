import { redirect } from "next/navigation";

/**
 * Admin sign-up moved into the single /register form: the invite code decides
 * the account type, and the ADMIN_SIGNUP_TOKEN value is simply one such code.
 * This route stays so bookmarked or emailed /admin-register links keep working.
 */
export default async function AdminRegisterRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { code } = await searchParams;
  const value = Array.isArray(code) ? code[0] : code;
  redirect(value ? `/register?code=${encodeURIComponent(value)}` : "/register");
}
