import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, BookOpen, Link2, ArrowLeft, UserCheck, ClipboardList, FileText, FileUp } from "lucide-react";
import MaterialTitleEdit from "./materials/material-title-edit";

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
      studentList: { orderBy: [{ lastName: "asc" }, { firstName: "asc" }] },
      learningMaterials: { orderBy: { createdAt: "desc" }, take: 3 },
      _count: { select: { enrollments: true, studentList: true, learningMaterials: true } },
    },
  });

  if (!cls) notFound();

  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") || headersList.get("host") || "localhost:3000";
  const proto = headersList.get("x-forwarded-proto") || "http";
  const appUrl = `${proto}://${host}`;

  // Build enrollment lookup to show enrollment status in preview
  const enrolledNames = new Set(
    cls.enrollments.map(
      (e) => `${e.student.user.firstName.toLowerCase()}|${e.student.user.lastName.toLowerCase()}`
    )
  );

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/teacher/classes"><ArrowLeft className="size-4" /> Classes</Link>
        </Button>
      </div>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{cls.name}</h1>
          {cls.description && <p className="text-muted-foreground mt-1">{cls.description}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" asChild>
            <Link href={`/teacher/classes/${cls.id}/invite`}><Link2 className="size-4" /> Invite Link</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Left Column: Topics + Learning Materials */}
        <div className="md:col-span-2 space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> Topics</CardTitle>
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

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2"><FileText className="size-4" /> Learning Materials</CardTitle>
              <Button size="sm" asChild>
                <Link href={`/teacher/classes/${cls.id}/materials`}>Manage Materials</Link>
              </Button>
            </CardHeader>
            <CardContent>
              {cls.learningMaterials.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p className="mb-3">No materials uploaded yet.</p>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/teacher/classes/${cls.id}/materials`}><FileUp className="size-4 mr-2" /> Upload Materials</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {cls.learningMaterials.map((mat) => (
                    <div key={mat.id} className="flex items-center justify-between p-3 rounded-lg border">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-50 rounded-md">
                          <FileText className="size-5 text-blue-600" />
                        </div>
                        <div>
                          <MaterialTitleEdit classId={cls.id} materialId={mat.id} title={mat.title} originalName={mat.originalName} className="font-medium text-sm" />
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                            <span>{(mat.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
                            <span>•</span>
                            <span>{mat.processingStatus === "SUCCESS" ? "Ready" : mat.processingStatus === "FAILED" ? "Failed" : "Processing"}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {cls._count.learningMaterials > 3 && (
                    <Button variant="ghost" size="sm" className="w-full mt-2" asChild>
                      <Link href={`/teacher/classes/${cls.id}/materials`}>
                        View all {cls._count.learningMaterials} materials
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Students + Invites */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="size-4" /> Student Roster</CardTitle>
              <Button size="sm" variant="outline" asChild>
                <Link href={`/teacher/classes/${cls.id}/students`}>Manage Roster</Link>
              </Button>
            </CardHeader>
            <CardContent>
              <div className="flex gap-3 mb-3 text-xs">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Users className="size-3" /> {cls._count.studentList} in roster
                </span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <UserCheck className="size-3" /> {cls._count.enrollments} enrolled
                </span>
              </div>
              {cls.studentList.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No students in roster yet.</p>
              ) : (
                <div className="space-y-2">
                  {cls.studentList.slice(0, 5).map((s) => {
                    const nameKey = `${s.firstName.toLowerCase()}|${s.lastName.toLowerCase()}`;
                    const isEnrolled = enrolledNames.has(nameKey);
                    return (
                      <div key={s.id} className="flex items-center gap-2">
                        <div className="size-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">
                          {s.firstName[0]}{s.lastName[0]}
                        </div>
                        <span className="text-sm flex-1">{s.firstName} {s.lastName}</span>
                        {isEnrolled ? (
                          <Badge variant="success" className="text-[10px] px-1.5 py-0">Enrolled</Badge>
                        ) : s.isRegistered ? (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Registered</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600">Pending</Badge>
                        )}
                      </div>
                    );
                  })}
                  {cls.studentList.length > 5 && (
                    <Button variant="ghost" size="sm" className="w-full" asChild>
                      <Link href={`/teacher/classes/${cls.id}/students`}>
                        <UserCheck className="size-3" /> View all {cls.studentList.length} students
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
                <CardTitle className="text-base flex items-center gap-2"><Link2 className="size-4" /> Active Invite Links</CardTitle>
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
