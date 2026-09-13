import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Atom } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { listStudentSimulations } from "@/lib/student-content";
import { SimulationsBrowser } from "./simulations-browser";

export const dynamic = "force-dynamic";

/**
 * Every simulation generated for the quizzes the student's classes were
 * actually assigned, grouped by class and quiz. A teacher who assigns quizzes
 * 1-3 to one class and 7-10 to another gives each class only its own
 * simulations; that scoping lives in listStudentSimulations (see
 * src/lib/student-content.ts) and is re-checked by the route that serves each
 * artifact.
 */
export default async function StudentSimulationsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) redirect("/login");

  const classes = await listStudentSimulations(student.id);
  const total = classes.reduce(
    (sum, cls) => sum + cls.quizzes.reduce((n, quiz) => n + quiz.simulations.length, 0),
    0
  );

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Simulations</h1>
        <p className="text-muted-foreground mt-1">
          {total === 0
            ? "Interactive simulations built from your classes' quizzes appear here."
            : `${total} interactive simulation${total !== 1 ? "s" : ""} from your classes' quizzes — change the parameters and watch what happens.`}
        </p>
      </div>

      {total === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Atom className="size-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No simulations yet</p>
            <p className="text-muted-foreground text-sm">
              Once your teacher publishes a quiz with simulations, they show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <SimulationsBrowser classes={classes} />
      )}
    </div>
  );
}
