import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ResourcesClient } from "./resources-client";

/**
 * Admin System Resources tab. The proxy already keeps non-admins out of
 * /admin/*, and /api/admin/resources re-checks the role on every request; this
 * server gate is the third layer, matching the other admin pages.
 */
export default async function AdminResourcesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  return <ResourcesClient />;
}
