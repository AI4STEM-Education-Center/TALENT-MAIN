"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Download, Loader2, Mail } from "lucide-react";
import { consentLevelLabel, type PoolEntry } from "@/lib/research-email";

export default function ResearchPoolPage() {
  const [entries, setEntries] = useState<PoolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/research-pool", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load the research pool.");
        const data = await res.json();
        if (!controller.signal.aborted) setEntries(data.entries);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unknown error.");
      });
    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!entries || !q) return entries ?? [];
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q),
    );
  }, [entries, query]);

  const counts = useMemo(() => {
    const list = entries ?? [];
    return {
      irb: list.filter((e) => e.viaIrb).length,
      survey: list.filter((e) => e.viaSurvey).length,
      students: list.filter((e) => e.role === "STUDENT").length,
      teachers: list.filter((e) => e.role === "TEACHER").length,
    };
  }, [entries]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Research Pool</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Everyone who agreed to take part — through the IRB consent form
            (their latest decision is Agree) or by opting in to interview
            contact at the end of the pre-survey. Someone who later withdraws
            consent drops out automatically.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href="/api/admin/research-pool?format=csv">
              <Download className="size-4" /> Export CSV
            </a>
          </Button>
          <Button asChild>
            <Link href="/admin/research-email/interview">
              <Mail className="size-4" /> Interview email
            </Link>
          </Button>
        </div>
      </div>

      {entries && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{entries.length} people</Badge>
          <Badge variant="outline">{counts.irb} via IRB</Badge>
          <Badge variant="outline">{counts.survey} via pre-survey</Badge>
          <Badge variant="outline">{counts.students} students</Badge>
          <Badge variant="outline">{counts.teachers} teachers</Badge>
          <Input
            aria-label="Search the pool"
            placeholder="Search name or email"
            className="ml-auto w-64"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !entries ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-2">Name</th>
                <th className="p-2">Role</th>
                <th className="p-2">Agreed via</th>
                <th className="p-2">IRB consent level</th>
                <th className="p-2">Since</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.key} className="border-t">
                  <td className="p-2">
                    <div>{e.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.email}
                    </div>
                  </td>
                  <td className="p-2 text-xs capitalize">
                    {e.role.toLowerCase()}
                  </td>
                  <td className="space-x-1 p-2">
                    {e.viaIrb && <Badge variant="secondary">IRB</Badge>}
                    {e.viaSurvey && <Badge variant="outline">Pre-survey</Badge>}
                  </td>
                  <td className="p-2 text-xs">
                    {consentLevelLabel(e.consentLevel) || "—"}
                  </td>
                  <td className="whitespace-nowrap p-2 text-xs">
                    {new Date(
                      (e.irbAgreedAt ?? e.surveyAgreedAt) as string,
                    ).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="p-6 text-center text-muted-foreground"
                  >
                    {entries.length === 0
                      ? "Nobody has joined the pool yet."
                      : "No matches."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
