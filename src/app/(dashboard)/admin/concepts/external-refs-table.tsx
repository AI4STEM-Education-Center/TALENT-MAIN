"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ExternalRefRow } from "./types";

interface ExternalRefsTableProps {
  externalRefs: ExternalRefRow[];
  search: string;
}

export function ExternalRefsTable({ externalRefs, search }: ExternalRefsTableProps) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? externalRefs.filter(
        (r) =>
          r.conceptId.toLowerCase().includes(q) ||
          r.refCode.toLowerCase().includes(q) ||
          r.refType.toLowerCase().includes(q)
      )
    : externalRefs;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span>External References</span>
          <span className="text-xs font-normal text-muted-foreground">
            {filtered.length} of {externalRefs.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No external references match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-3 font-medium">Concept ID</th>
                  <th className="py-2 pr-3 font-medium">Ref Code</th>
                  <th className="py-2 pr-3 font-medium">Type</th>
                  <th className="py-2 pr-3 font-medium">Source URL</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{r.conceptId}</td>
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{r.refCode}</td>
                    <td className="py-2 pr-3">
                      <Badge variant="secondary">{r.refType}</Badge>
                    </td>
                    <td className="py-2 pr-3">
                      {r.sourceUrl ? (
                        <a
                          href={r.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline text-xs break-all"
                        >
                          {r.sourceUrl}
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
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
