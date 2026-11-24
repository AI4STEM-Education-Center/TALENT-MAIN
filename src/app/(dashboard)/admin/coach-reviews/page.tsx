import { CoachReviewsClient } from "@/components/teacher/CoachReviewsClient";

export default function AdminCoachReviewsPage() {
  return (
    <CoachReviewsClient
      apiBasePath="/api/admin/coach-reviews"
      heading="Wrong Answer Coach Reviews (Admin)"
      subheading="Inspect flagged diagnostic sessions across all classes and record review decisions."
    />
  );
}
