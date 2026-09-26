import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ResearchEmailComposer } from "@/components/admin/research/ResearchEmailComposer";

export default function ResearchPoolEmailPage() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="space-y-1">
        <Link
          href="/admin/research-pool"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Research pool
        </Link>
        <h1 className="text-3xl font-bold">Email the research pool</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each person gets their own copy (nobody sees other recipients). People
          who agreed through the IRB consent form get the IRB version; people
          who opted in on the pre-survey get the survey version.
        </p>
      </div>
      <ResearchEmailComposer kind="POOL" />
    </div>
  );
}
