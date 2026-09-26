import type { Metadata } from "next";
import { SurveyLinkClient } from "./survey-link-client";

export const metadata: Metadata = {
  title: "Survey — AI4Talent",
  robots: { index: false, follow: false },
};

/**
 * Public post-survey page reached from a research email. The token in the URL
 * is the only credential (see src/proxy.ts and /api/surveys/invite/[token]).
 */
export default async function SurveyLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl rounded-lg border bg-card p-6 shadow-sm">
        <SurveyLinkClient token={token} />
      </div>
    </main>
  );
}
