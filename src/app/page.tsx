import type { Metadata } from "next";
import Link from "next/link";
import { BookOpen, LineChart, Sparkles } from "lucide-react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Adaptive Learning - Guided science education for every student",
  description:
    "An adaptive learning platform providing personalized science education with AI-driven insights for teachers and students.",
};

/** What the platform actually does, in the order a visitor cares about it. */
const FEATURES = [
  {
    icon: BookOpen,
    title: "Quizzes that adapt",
    body: "Each attempt is marked against the concepts behind the questions, not just the answers.",
  },
  {
    icon: Sparkles,
    title: "Feedback that explains",
    body: "Every result comes back with the reasoning, the pages to reread, and a simulation to try.",
  },
  {
    icon: LineChart,
    title: "Class-level signal",
    body: "Teachers see the distribution and the per-question weak spots, not a single average.",
  },
];

export default async function HomePage() {
  const session = await auth();

  if (session?.user) {
    if (session.user.role === "TEACHER") redirect("/teacher");
    else if (session.user.role === "ADMIN") redirect("/admin");
    else redirect("/student");
  }

  return (
    // Token-driven, so the landing page shares the app's surfaces instead of the
    // hard-coded slate/blue gradient it used to carry — which matched nothing
    // else, so signing in changed the palette under you.
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-16">
      <div className="w-full max-w-3xl">
        <div className="flex flex-col items-center text-center">
          <span className="mb-6 flex size-16 items-center justify-center rounded-[var(--radius)] bg-primary/10">
            <BookOpen className="size-8 text-primary" />
          </span>

          <h1 className="text-4xl font-semibold sm:text-5xl">
            Adaptive Learning
          </h1>
          <p className="mt-4 max-w-xl text-lg text-muted-foreground">
            Guided science education for every student — with the reasoning
            shown, not just the score.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/register">Teacher sign up</Link>
            </Button>
          </div>

          <p className="mt-6 text-sm text-muted-foreground">
            Students: use the invitation link from your teacher to create an
            account and join your class.
          </p>
        </div>

        <ul className="mt-14 grid gap-4 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <li
              key={feature.title}
              className="surface-card p-[var(--pad-card)]"
            >
              <feature.icon
                className="size-5 text-primary"
                aria-hidden="true"
              />
              <h2 className="mt-3 text-base font-semibold">{feature.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {feature.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
