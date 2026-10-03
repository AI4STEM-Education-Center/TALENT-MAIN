import { ResearchEmailComposer } from "@/components/admin/research/ResearchEmailComposer";

export default function PostSurveyEmailPage() {
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Invites students and teachers to the post-survey. It never blocks anyone
        in the app — each recipient gets a personal{" "}
        <code className="font-mono">{"{{surveyLink}}"}</code> that opens their
        role&apos;s enabled post-survey without signing in and works once.
      </p>
      <ResearchEmailComposer kind="POST_SURVEY" />
    </div>
  );
}
