"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MisconceptionRow } from "./types";

const LONG_STATEMENT_THRESHOLD = 160;

function MisconceptionStatement({ statement }: { statement: string }) {
  if (statement.length <= LONG_STATEMENT_THRESHOLD) {
    return <p className="text-sm whitespace-pre-wrap">{statement}</p>;
  }
  return (
    <details className="text-sm">
      <summary className="cursor-pointer select-none">
        {statement.slice(0, LONG_STATEMENT_THRESHOLD)}…
      </summary>
      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
        {statement}
      </p>
    </details>
  );
}

interface MisconceptionsTableProps {
  misconceptions: MisconceptionRow[];
  search: string;
  showDeprecated: boolean;
}

export function MisconceptionsTable({
  misconceptions,
  search,
  showDeprecated,
}: MisconceptionsTableProps) {
  const q = search.trim().toLowerCase();
  const filtered = misconceptions.filter((m) => {
    if (!showDeprecated && m.deprecated) return false;
    if (!q) return true;
    return (
      m.misconceptionId.toLowerCase().includes(q) ||
      m.statement.toLowerCase().includes(q) ||
      (m.sourceType ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span>Misconceptions</span>
          <span className="text-xs font-normal text-muted-foreground">
            {filtered.length} of {misconceptions.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No misconceptions match.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Misconception ID</th>
                  <th className="py-2 pr-3 font-medium">Statement</th>
                  <th className="py-2 pr-3 font-medium">Source Type</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">
                      {m.misconceptionId}
                    </td>
                    <td className="py-2 pr-3 max-w-md">
                      <MisconceptionStatement statement={m.statement} />
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                      {m.sourceType ?? "—"}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {m.deprecated ? (
                        <Badge
                          variant="warning"
                          title={m.deprecationNote ?? undefined}
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
