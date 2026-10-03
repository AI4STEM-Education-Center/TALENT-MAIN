import { ResearchEmailComposer } from "@/components/admin/research/ResearchEmailComposer";

export default function InterviewEmailPage() {
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Invites people who agreed to an interview — on the IRB consent form or
        by opting in at the end of the pre-survey. IRB participants get the IRB
        version; pre-survey opt-ins get the survey version. Replies go to the
        reply-to address.
      </p>
      <ResearchEmailComposer kind="POOL" />
    </div>
  );
}
