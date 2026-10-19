import { requireAdminDataPage } from "@/lib/admin-access";
import { isAdmin } from "@/lib/roles";
import { PoolSubmissionsClient } from "./pool-submissions-client";
import { prisma } from "@/lib/prisma";

export default async function PoolSubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const session = await requireAdminDataPage();
  // An admin reviews the requests assigned to them; a research scientist
  // sees every request, read-only.
  const canReview = isAdmin(session.user.role);
  const [{ request }, submissions] = await Promise.all([
    searchParams,
    prisma.poolSubmission.findMany({
      where: canReview ? { reviewerId: session.user.id } : {},
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
      canReview={canReview}
      initialSubmissions={submissions.map((submission) => ({
        ...submission,
        createdAt: submission.createdAt.toISOString(),
      }))}
    />
  );
}
