import { requireAdminPage } from "@/lib/admin-access";
import { PressureTestsClient } from "./pressure-tests-client";

export default async function AdminPressureTestsPage() {
  await requireAdminPage();
  return <PressureTestsClient />;
}
