import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PressureTestsClient } from "./pressure-tests-client";

export default async function AdminPressureTestsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  return <PressureTestsClient />;
}
