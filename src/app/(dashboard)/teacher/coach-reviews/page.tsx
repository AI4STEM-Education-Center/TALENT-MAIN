import { CoachReviewsClient } from "@/components/teacher/CoachReviewsClient";

export default function TeacherCoachReviewsPage() {
  return (
    <CoachReviewsClient
      apiBasePath="/api/teacher/coach-reviews"
      heading="Wrong Answer Coach Reviews"
      subheading="Inspect flagged diagnostic sessions across your classes and record instructor review decisions."
    />
  );
}
