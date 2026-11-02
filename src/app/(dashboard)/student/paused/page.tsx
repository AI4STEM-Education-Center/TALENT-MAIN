import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getStudentPause } from "@/lib/class-access-pause";
import { PausedView } from "./paused-view";

export const dynamic = "force-dynamic";

/**
 * Where the proxy sends a student whose classes are all disabled. Reachable
 * while paused (see isPauseExempt); a student who is not paused (anymore) is
 * sent back to the dashboard instead of seeing a stale notice.
 */
export default async function StudentPausedPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");
  const state = await getStudentPause(session.user.id);
  if (!state.paused) redirect("/student");
  return <PausedView message={state.message ?? ""} />;
}
