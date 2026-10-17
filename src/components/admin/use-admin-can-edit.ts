"use client";
import { useSession } from "next-auth/react";
import { isAdmin } from "@/lib/roles";

/**
 * Whether the signed-in user may use the mutation controls (create / edit /
 * delete / toggle) on an admin page. False for research scientists, who see
 * the same pages read-only, and while the session is still loading — so a
 * control never flashes on for someone the API would refuse.
 *
 * UI only: every write route re-checks the ADMIN role server-side.
 */
export function useAdminCanEdit(): boolean {
  const { data } = useSession();
  return isAdmin(data?.user?.role);
}
