import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { FeedbackResultsPanel } from "@/components/feedback/FeedbackResultsPanel";

/**
 * Site-wide consolidated feedback results: every student verdict on post-quiz
 * recommendations and every teacher verdict on a generated simulation, across
 * all classes. Same panel as the teacher route — the API widens the scope for
 * an admin session (see content-feedback-access.ts).
 */
export default async function AdminFeedbackPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") redirect("/login");

  return (
    <div className="p-4 md:p-8">
      <FeedbackResultsPanel />
    </div>
  );
}
