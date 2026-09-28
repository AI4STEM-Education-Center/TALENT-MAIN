import { ResearchEmailComposer } from "@/components/admin/research/ResearchEmailComposer";

export default function PostSurveyEmailPage() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold">Post-survey email</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Schedule the email that invites students and teachers to the
          post-survey. It never blocks anyone in the app — each recipient gets a
          personal <code className="font-mono">{"{{surveyLink}}"}</code> that
          opens their role&apos;s enabled post-survey without signing in and
          works once.
        </p>
      </div>
      <ResearchEmailComposer kind="POST_SURVEY" />
    </div>
  );
}
