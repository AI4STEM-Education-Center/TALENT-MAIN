import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PoolSubmissionsClient } from "./pool-submissions-client";
import { prisma } from "@/lib/prisma";

export default async function PoolSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");
  const [{ request }, submissions] = await Promise.all([
    searchParams,
    prisma.poolSubmission.findMany({
      where: { reviewerId: session.user.id },
      include: {
        teacher: {
          select: {
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        quiz: {
          select: {
            id: true,
            name: true,
            _count: { select: { questions: true } },
          },
        },
        material: {
          select: {
            id: true,
            title: true,
            originalName: true,
            totalPages: true,
          },
        },
        topic: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return (
    <PoolSubmissionsClient
      requestedId={request ?? null}
      initialSubmissions={submissions.map((submission) => ({
        ...submission,
        createdAt: submission.createdAt.toISOString(),
      }))}
    />
  );
}
