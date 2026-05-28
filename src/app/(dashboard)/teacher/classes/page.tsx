import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Users, BookOpen } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default async function ClassesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) redirect("/login");

  const classes = await prisma.class.findMany({
    where: { teacherId: teacher.id },
    include: {
      _count: { select: { enrollments: true, classTopics: true } },
      classTopics: { where: { published: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Classes</h1>
          <p className="text-muted-foreground mt-1">{classes.length} class{classes.length !== 1 ? "es" : ""}</p>
        </div>
        <Button asChild>
          <Link href="/teacher/classes/new"><Plus className="w-4 h-4" /> New Class</Link>
        </Button>
      </div>

      {classes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="w-12 h-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No classes yet</p>
            <p className="text-muted-foreground text-sm mb-4">Create your first class and invite students.</p>
            <Button asChild><Link href="/teacher/classes/new"><Plus className="w-4 h-4" /> Create Class</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {classes.map((cls) => (
            <Card key={cls.id} className="hover:shadow-md transition-shadow">
              <CardContent className="flex items-center justify-between p-5">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">{cls.name}</h2>
                    {cls.classTopics.length > 0 && (
                      <Badge variant="success">{cls.classTopics.length} published</Badge>
                    )}
                  </div>
                  {cls.description && <p className="text-sm text-muted-foreground">{cls.description}</p>}
                  <div className="flex gap-4 text-xs text-muted-foreground pt-1">
                    <span className="flex items-center gap-1"><Users className="w-3 h-3" />{cls._count.enrollments} students</span>
                    <span className="flex items-center gap-1"><BookOpen className="w-3 h-3" />{cls._count.classTopics} topics</span>
                    <span>Created {formatDate(cls.createdAt)}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/teacher/classes/${cls.id}/invite`}>Invite</Link>
                  </Button>
                  <Button size="sm" asChild>
                    <Link href={`/teacher/classes/${cls.id}`}>Manage</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
