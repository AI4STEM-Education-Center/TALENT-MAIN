"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConceptRow } from "./types";

const LONG_DESCRIPTION_THRESHOLD = 160;

function ConceptDescription({ description }: { description: string | null }) {
  if (!description)
    return <span className="text-xs text-muted-foreground">—</span>;
  if (description.length <= LONG_DESCRIPTION_THRESHOLD) {
    return (
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
        {description}
      </p>
    );
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground">
        {description.slice(0, LONG_DESCRIPTION_THRESHOLD)}…
      </summary>
      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
        {description}
      </p>
    </details>
  );
}

interface ConceptsTableProps {
  concepts: ConceptRow[];
  search: string;
  showDeprecated: boolean;
}

export function ConceptsTable({
  concepts,
  search,
  showDeprecated,
}: ConceptsTableProps) {
  const q = search.trim().toLowerCase();
  const filtered = concepts.filter((c) => {
    if (!showDeprecated && c.deprecated) return false;
    if (!q) return true;
    return (
      c.conceptId.toLowerCase().includes(q) ||
      c.displayName.toLowerCase().includes(q) ||
      (c.unit ?? "").toLowerCase().includes(q) ||
      (c.topic ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span>Concepts</span>
          <span className="text-xs font-normal text-muted-foreground">
            {filtered.length} of {concepts.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No concepts match.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Concept ID</th>
                  <th className="py-2 pr-3 font-medium">Kind</th>
                  <th className="py-2 pr-3 font-medium">Unit / Topic</th>
                  <th className="py-2 pr-3 font-medium">Display Name</th>
                  <th className="py-2 pr-3 font-medium">Description</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                      {c.conceptId}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{c.kind}</td>
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                      {[c.unit, c.topic].filter(Boolean).join(" / ") || "—"}
                    </td>
                    <td className="py-2 pr-3">{c.displayName}</td>
                    <td className="py-2 pr-3 max-w-sm">
                      <ConceptDescription description={c.description} />
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {c.deprecated ? (
                        <Badge
                          variant="warning"
                          title={c.deprecationNote ?? undefined}
                        >
                          Deprecated
                        </Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
