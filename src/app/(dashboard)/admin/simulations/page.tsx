import { redirect } from "next/navigation";
import { getContentActor } from "@/lib/quiz-access";
import { AdminSimulationsClient } from "./simulations-client";

export default async function AdminSimulationsPage() {
  const actor = await getContentActor();
  if (!actor || actor.role !== "ADMIN") redirect("/login");
  return <AdminSimulationsClient />;
}
