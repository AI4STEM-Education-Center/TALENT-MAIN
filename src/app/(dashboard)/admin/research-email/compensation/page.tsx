import { ResearchEmailComposer } from "@/components/admin/research/ResearchEmailComposer";

export default function CompensationEmailPage() {
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Thanks students who completed a post-survey and asks them to reply to
        arrange their compensation. Choose which study periods count — either
        one, or both. Replies go to the reply-to address, and students already
        reached by an earlier compensation email can be skipped.
      </p>
      <ResearchEmailComposer kind="COMPENSATION" />
    </div>
  );
}
