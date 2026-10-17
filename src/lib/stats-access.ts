import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { canViewAdminData } from "@/lib/roles";

export type StatsAudience = "teacher" | "admin";

/**
 * Read-only statistics access. Never use this to authorize class mutations.
 * The "admin" audience is the site-wide view: administrators and research
 * scientists (canViewAdminData). The "teacher" audience is teachers only, and
 * requireStatsClass further pins them to their own classes.
 */
export async function requireStatsUser(audience: StatsAudience) {
  const session = await auth();
  const allowed =
    audience === "admin"
      ? canViewAdminData(session?.user?.role)
      : session?.user?.role === "TEACHER";
  if (!session?.user || !allowed) redirect("/login");
  return session.user;
}

export async function requireStatsClass(
  classId: string,
  audience: StatsAudience,
) {
  const user = await requireStatsUser(audience);
  const cls = await prisma.class.findFirst({
    where: {
      id: classId,
      ...(audience === "teacher" ? { teacher: { userId: user.id } } : {}),
    },
    include: {
      studentList: { orderBy: [{ lastName: "asc" }, { firstName: "asc" }] },
    },
  });
  if (!cls) notFound();
  return cls;
}
