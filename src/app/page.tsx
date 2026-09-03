import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Adaptive Learning - Guided science education for every student",
  description:
    "An adaptive learning platform providing personalized science education with AI-driven insights for teachers and students.",
};

export default async function HomePage() {
  const session = await auth();

  if (session?.user) {
    if (session.user.role === "TEACHER") redirect("/teacher");
    else if (session.user.role === "ADMIN") redirect("/admin");
    else redirect("/student");
  }

  return (
    <main className="min-h-screen bg-linear-to-br from-slate-900 via-blue-950 to-slate-900 flex items-center justify-center px-4">
      <div className="max-w-2xl w-full text-center space-y-8">
        <div className="space-y-4">
          <div className="inline-flex items-center justify-center size-20 rounded-2xl bg-blue-500/20 border border-blue-400/30 mb-4">
            <svg
              className="size-10 text-blue-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.966 8.966 0 00-6 2.292m0-14.25v14.25"
              />
            </svg>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-white">
            Adaptive Learning temp temp
          </h1>
          <p className="text-xl text-slate-300">
            Guided science education for every student
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/login"
            className="px-8 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            className="px-8 py-3 rounded-lg border border-slate-500 hover:border-slate-400 text-slate-200 hover:text-white font-semibold transition-colors"
          >
            Teacher Sign Up
          </Link>
        </div>

        <p className="text-sm text-slate-500">
          Students: use the invitation link from your teacher to create an
          account and join your class.
        </p>
      </div>
    </main>
  );
}
