import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, BookOpen, Link2, ArrowLeft, UserCheck } from "lucide-react";

export default async function ClassDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");
  const { id } = await params;

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const cls = await prisma.class.findFirst({
    where: { id, teacherId: teacher?.id ?? "" },
    include: {
      enrollments: { include: { student: { include: { user: true } } }, orderBy: { joinedAt: "desc" } },
      classTopics: { include: { topic: { include: { subtopics: true } } }, orderBy: { topic: { order: "asc" } } },
      invitations: { where: { active: true }, orderBy: { createdAt: "desc" }, take: 3 },
      _count: { select: { enrollments: true } },
    },
  });

  if (!cls) notFound();

  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") || headersList.get("host") || "localhost:3000";
  const proto = headersList.get("x-forwarded-proto") || "http";
  const appUrl = `${proto}://${host}`;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/teacher/classes"><ArrowLeft className="w-4 h-4" /> Classes</Link>
        </Button>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">{cls.name}</h1>
          {cls.description && <p className="text-muted-foreground mt-1">{cls.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href={`/teacher/classes/${cls.id}/invite`}><Link2 className="w-4 h-4" /> Invite Link</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Topics Section */}
        <div className="md:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2"><BookOpen className="w-4 h-4" /> Topics</CardTitle>
              <Button size="sm" asChild>
                <Link href={`/teacher/classes/${cls.id}/topics`}>Manage Topics</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {cls.classTopics.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="mb-3">No topics assigned yet.</p>
                  <Button size="sm" asChild>
                    <Link href={`/teacher/classes/${cls.id}/topics`}>Add Topics</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {cls.classTopics.map((ct) => (
                    <div key={ct.id} className="flex items-center justify-between p-3 rounded-lg border">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{ct.topic.name}</span>
                          <Badge variant={ct.published ? "success" : "secondary"}>
                            {ct.published ? "Published" : "Draft"}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {ct.topic.subtopics.length} module{ct.topic.subtopics.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Students + Invites */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><Users className="w-4 h-4" /> Students</CardTitle>
              <Badge variant="secondary">{cls._count.enrollments}</Badge>
            </CardHeader>
            <CardContent>
              {cls.enrollments.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No students yet.</p>
              ) : (
                <div className="space-y-2">
                  {cls.enrollments.slice(0, 5).map((e) => (
                    <div key={e.id} className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                        {e.student.user.firstName[0]}{e.student.user.lastName[0]}
                      </div>
                      <span className="text-sm">{e.student.user.firstName} {e.student.user.lastName}</span>
                    </div>
                  ))}
                  {cls.enrollments.length > 5 && (
                    <Button variant="ghost" size="sm" className="w-full" asChild>
                      <Link href={`/teacher/classes/${cls.id}/students`}>
                        <UserCheck className="w-3 h-3" /> View all {cls.enrollments.length} students
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {cls.invitations.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><Link2 className="w-4 h-4" /> Active Invite Links</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {cls.invitations.map((inv) => (
                  <div key={inv.id} className="p-2 rounded border bg-muted/30 text-xs">
                    <p className="font-mono truncate">{appUrl}/invite/{inv.token}</p>
                    <p className="text-muted-foreground mt-0.5">
                      {inv.usedCount}{inv.maxUses ? `/${inv.maxUses}` : ""} uses
                      {inv.expiresAt && ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="w-full" asChild>
                  <Link href={`/teacher/classes/${cls.id}/invite`}>Manage Links</Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
