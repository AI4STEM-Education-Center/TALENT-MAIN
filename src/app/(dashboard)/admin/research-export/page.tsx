import { Download } from "lucide-react";
import { requireAdminDataPage } from "@/lib/admin-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function ResearchExportPage() {
  await requireAdminDataPage();

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Research Data Export
        </h1>
        <p className="mt-2 text-muted-foreground">
          Download all retained records from this site as CSV files in one ZIP.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Complete research dataset</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>
              Users, class rosters, enrollments, course structure, and learning
              content.
            </li>
            <li>
              Graded quiz attempts and answers, archived exam results, AI
              recommendations, and separate practice attempts.
            </li>
            <li>
              Simulation sessions, interaction and time measurements, versions,
              and feedback.
            </li>
            <li>
              Student and teacher AI conversations, including archived
              transcripts, messages, and attachment metadata.
            </li>
            <li>
              Consent decisions and form versions, pre/post surveys and answers,
              and research outreach records.
            </li>
            <li>
              AI configuration and generation metrics, guardrails, and retained
              operational logs.
            </li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Stable IDs connect the files for analysis. The ZIP includes a data
            dictionary, a manifest with record counts, and a guide to joins and
            JSON fields. All database records come from one consistent snapshot.
          </p>
          <p className="text-sm text-muted-foreground">
            This export contains identifiable data, including names, emails,
            consent signatures, and free text. It includes both agreement and
            decline records; use the consent data to select your research
            cohort. Passwords, access tokens, and service credentials are
            excluded.
          </p>
          <p className="text-sm text-muted-foreground">
            Uploaded files and simulation HTML are represented by their
            metadata. Deleted records and external monitoring files are
            unavailable. Large exports may take several minutes to prepare
            before the download begins. Keep this page open while it prepares.
          </p>
          <Button asChild>
            <a href="/api/admin/research-export" download>
              <Download className="size-4" /> Download research ZIP
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
