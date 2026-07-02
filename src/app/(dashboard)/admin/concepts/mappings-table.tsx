"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfidenceBadge } from "./confidence-badge";
import type { MappingRow } from "./types";

interface MappingsTableProps {
  mappings: MappingRow[];
  search: string;
}

export function MappingsTable({ mappings, search }: MappingsTableProps) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? mappings.filter(
        (m) =>
          m.misconceptionId.toLowerCase().includes(q) ||
          m.conceptId.toLowerCase().includes(q) ||
          m.misconceptionStatement.toLowerCase().includes(q) ||
          m.conceptDisplayName.toLowerCase().includes(q)
      )
    : mappings;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span>Concept ↔ Misconception Mappings</span>
          <span className="text-xs font-normal text-muted-foreground">
            {filtered.length} of {mappings.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No mappings match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Misconception</th>
                  <th className="py-2 pr-3 font-medium">Concept</th>
                  <th className="py-2 pr-3 font-medium">Confidence</th>
                  <th className="py-2 pr-3 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="py-2 pr-3">
                      <span className="font-mono text-xs whitespace-nowrap">{m.misconceptionId}</span>
                      <p className="text-xs text-muted-foreground truncate max-w-xs">
                        {m.misconceptionStatement}
                      </p>
                    </td>
                    <td className="py-2 pr-3">
                      <span className="font-mono text-xs whitespace-nowrap">{m.conceptId}</span>
                      <p className="text-xs text-muted-foreground truncate max-w-xs">
                        {m.conceptDisplayName}
                      </p>
                    </td>
                    <td className="py-2 pr-3">
                      <ConfidenceBadge confidence={m.confidence} />
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground max-w-xs truncate">{m.notes ?? "—"}</td>
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
