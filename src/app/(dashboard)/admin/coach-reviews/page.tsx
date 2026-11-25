import { requireAdminDataPage } from "@/lib/admin-access";
import { CoachReviewsClient } from "@/components/teacher/CoachReviewsClient";

export default async function AdminCoachReviewsPage() {
  await requireAdminDataPage();
  return (
    <CoachReviewsClient
      apiBasePath="/api/admin/coach-reviews"
      heading="Wrong Answer Coach Sessions"
      subheading="View recorded diagnostic sessions and 5-run Decisions API classifications across all classes."
    />
  );
}
