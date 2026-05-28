import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Users } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default async function StudentsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id } = await params;

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({
    where: { id, teacherId: teacher?.id ?? "" },
    include: {
      enrollments: {
        include: { student: { include: { user: true } } },
        orderBy: { joinedAt: "desc" },
      },
    },
  });

  if (!cls) notFound();

  return (
    <div className="p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${cls.id}`}><ArrowLeft className="w-4 h-4" /> Back to {cls.name}</Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="w-6 h-6" /> Students</h1>
        <p className="text-muted-foreground text-sm mt-1">{cls.enrollments.length} enrolled in {cls.name}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Enrolled Students</CardTitle>
        </CardHeader>
        <CardContent>
          {cls.enrollments.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <p>No students enrolled yet.</p>
              <Button variant="outline" size="sm" className="mt-3" asChild>
                <Link href={`/teacher/classes/${cls.id}/invite`}>Create Invite Link</Link>
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {cls.enrollments.map((e) => (
                <div key={e.id} className="flex items-center gap-3 py-3">
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary text-sm">
                    {e.student.user.firstName[0]}{e.student.user.lastName[0]}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium">{e.student.user.firstName} {e.student.user.lastName}</p>
                    <p className="text-xs text-muted-foreground">{e.student.user.email} · @{e.student.user.username}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">Joined {formatDate(e.joinedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
