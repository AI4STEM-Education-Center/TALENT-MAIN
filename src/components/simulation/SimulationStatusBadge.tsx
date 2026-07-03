import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

/**
 * Status badge for a question's simulation. `status` is the
 * QuestionSimulation.status string, or null when no simulation row exists yet.
 * Shared by the admin dashboard and the teacher quiz editor.
 */
export function SimulationStatusBadge({ status }: { status: string | null }) {
  switch (status) {
    case "READY":
      return <Badge variant="success">Ready</Badge>;
    case "DECLINED":
      return <Badge variant="secondary">Declined</Badge>;
    case "FAILED":
      return <Badge variant="destructive">Failed</Badge>;
    case "PENDING":
      return (
        <Badge variant="outline">
          <Loader2 className="size-3 mr-1 animate-spin" /> Generating…
        </Badge>
      );
    case "REVISING":
      return (
        <Badge variant="outline">
          <Loader2 className="size-3 mr-1 animate-spin" /> Revising…
        </Badge>
      );
    default:
      return <Badge variant="outline">None</Badge>;
  }
}
