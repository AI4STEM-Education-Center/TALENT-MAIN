import { requireAdminPage } from "@/lib/admin-access";
import { ResourcesClient } from "./resources-client";

/**
 * Admin System Resources tab. The proxy already keeps non-admins out of
 * /admin/*, and /api/admin/resources re-checks the role on every request; this
 * server gate is the third layer, matching the other admin pages.
 */
export default async function AdminResourcesPage() {
  await requireAdminPage();

  return <ResourcesClient />;
}
