import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { FeedbackResultsPanel } from "@/components/feedback/FeedbackResultsPanel";

/**
 * A teacher's consolidated feedback results: what their students said about
 * the materials and simulations recommended after a quiz, plus the teacher's
 * own verdicts on the simulations generated for them.
 *
 * Scope is enforced by the API from the session (see content-feedback-access.ts),
 * not by this page — the panel is the same component the admin route renders.
 */
export default async function TeacherFeedbackPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  return (
    <div className="p-4 md:p-8">
      <FeedbackResultsPanel />
    </div>
  );
}
