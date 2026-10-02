import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";

export type StatsAudience = "teacher" | "admin";

/** Read-only statistics access. Never use this to authorize class mutations. */
export async function requireStatsUser(audience: StatsAudience) {
  const session = await auth();
  const role = audience === "admin" ? "ADMIN" : "TEACHER";
  if (!session?.user || session.user.role !== role) redirect("/login");
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
