import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FileText, ScrollText } from "lucide-react";
import { auth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SyllabusView } from "@/components/syllabus/SyllabusView";
import { AskAssistantButton } from "@/components/syllabus/AskAssistantButton";
import { formatDate } from "@/lib/format-date";
import { isoDay } from "@/lib/syllabus";
import {
  enrolledClass,
  findSyllabus,
  toStudentView,
} from "@/lib/syllabus-server";

export default async function StudentSyllabusPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const cls = await enrolledClass(session.user.id, id);
  if (!cls) notFound();
  const row = await findSyllabus(cls.id);
  const syllabus = row ? toStudentView(row) : null;

  return (
    <div className="max-w-5xl space-y-6 p-4 md:p-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/student/classes/${cls.id}`}>
          <ArrowLeft className="size-4" /> {cls.name}
        </Link>
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Syllabus</h1>
          {syllabus && (
            <p className="mt-1 text-sm text-muted-foreground">
              Last updated {formatDate(syllabus.updatedAt)}
            </p>
          )}
        </div>
        {syllabus && (
          <div className="flex gap-2">
            <AskAssistantButton />
            {syllabus.hasFile && (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={`/api/classes/${cls.id}/syllabus/file`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <FileText className="size-4" /> Original PDF
                </a>
              </Button>
            )}
          </div>
        )}
      </div>

      {syllabus ? (
        <SyllabusView content={syllabus.content} today={isoDay(new Date())} />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center py-12 text-center">
            <ScrollText className="mb-3 size-12 text-muted-foreground" />
            <p className="text-lg font-medium">No syllabus yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your teacher hasn&apos;t posted a syllabus for this class.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
