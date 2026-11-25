import { CoachReviewsClient } from "@/components/teacher/CoachReviewsClient";

export default function AdminCoachReviewsPage() {
  return (
    <CoachReviewsClient
      apiBasePath="/api/admin/coach-reviews"
      heading="Wrong Answer Coach Sessions (Admin)"
      subheading="View recorded diagnostic sessions and 5-run Decisions API classifications across all classes."
    />
  );
}
