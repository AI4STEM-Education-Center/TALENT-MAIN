import { CoachReviewsClient } from "@/components/teacher/CoachReviewsClient";

export default function TeacherCoachReviewsPage() {
  return (
    <CoachReviewsClient
      apiBasePath="/api/teacher/coach-reviews"
      heading="Wrong Answer Coach Sessions"
      subheading="View recorded diagnostic sessions and 5-run Decisions API classifications across your classes."
    />
  );
}
