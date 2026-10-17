import { requireAdminDataPage } from "@/lib/admin-access";
import { isAdmin } from "@/lib/roles";
import { AdminSimulationsClient } from "./simulations-client";

export default async function AdminSimulationsPage() {
  // Research scientists browse the simulations read-only.
  const session = await requireAdminDataPage();
  return <AdminSimulationsClient canEdit={isAdmin(session.user.role)} />;
}
