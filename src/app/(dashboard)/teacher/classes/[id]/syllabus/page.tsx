import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { TeacherSyllabusPanel } from "@/components/syllabus/TeacherSyllabusPanel";
import { isoDay } from "@/lib/syllabus";
import { findSyllabus, ownedClass, toTeacherView } from "@/lib/syllabus-server";

export default async function TeacherSyllabusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  const cls = await ownedClass(session.user.id, id);
  if (!cls) notFound();
  const row = await findSyllabus(cls.id);

  return (
    <div className="max-w-5xl space-y-6 p-4 md:p-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/teacher/classes/${cls.id}`}>
          <ArrowLeft className="size-4" /> {cls.name}
        </Link>
      </Button>
      <div>
        <h1 className="text-3xl font-bold">Syllabus</h1>
        <p className="mt-1 text-muted-foreground">
          Upload the syllabus for {cls.name}. Its course details, policies and
          dates are extracted for you to review and edit, and students can read
          it and ask the assistant about it.
        </p>
      </div>
      <TeacherSyllabusPanel
        classId={cls.id}
        syllabus={row ? toTeacherView(row) : null}
        today={isoDay(new Date())}
      />
    </div>
  );
}
