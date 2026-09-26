"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import {
  formatAnswer,
  type SurveyAnswers,
  type SurveyQuestion,
} from "@/lib/survey";

type ResponseRow = {
  id: string;
  submittedAt: string;
  source: string;
  nameSnapshot: string;
  emailSnapshot: string;
  irbAgreed: boolean;
  interviewOptIn: boolean;
  interviewEmail: string | null;
  answers: SurveyAnswers;
};

type Data = {
  form: { id: string; title: string; kind: string; role: string };
  questions: SurveyQuestion[];
  responses: ResponseRow[];
  total: number;
};

export default function SurveyResponsesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/surveys/${id}/responses`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load responses.");
        const body: Data = await res.json();
        if (!controller.signal.aborted) setData(body);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unknown error.");
      });
    return () => controller.abort();
  }, [id]);

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  if (!data)
    return (
      <div className="flex justify-center p-12 text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
      </div>
    );

  const answerable = data.questions.filter((q) => q.type !== "section");
  const isPre = data.form.kind === "PRE";

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href="/admin/surveys"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Surveys
          </Link>
          <h1 className="text-2xl font-bold">{data.form.title}</h1>
          <p className="text-sm text-muted-foreground">
            {data.total} response{data.total === 1 ? "" : "s"}
            {data.total > data.responses.length
              ? ` — showing the latest ${data.responses.length}; the CSV has all of them`
              : ""}
          </p>
        </div>
        <Button asChild disabled={data.total === 0}>
          <a href={`/api/admin/surveys/${id}/responses?format=csv`}>
            <Download className="size-4" /> Export CSV
          </a>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-2">Respondent</th>
              <th className="p-2">Submitted</th>
              <th className="p-2">IRB</th>
              {isPre && <th className="p-2">Interview contact</th>}
              {answerable.map((q, i) => (
                <th
                  key={q.id}
                  className="min-w-48 p-2 normal-case"
                  title={q.text}
                >
                  Q{i + 1}.{" "}
                  {q.text.length > 60 ? `${q.text.slice(0, 57)}…` : q.text}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.responses.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="p-2">
                  <div>{r.nameSnapshot}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.emailSnapshot}
                  </div>
                  {r.source === "LINK" && (
                    <Badge variant="outline" className="mt-1">
                      Email link
                    </Badge>
                  )}
                </td>
                <td className="whitespace-nowrap p-2 text-xs">
                  {new Date(r.submittedAt).toLocaleString()}
                </td>
                <td className="p-2 text-xs">{r.irbAgreed ? "Agreed" : "—"}</td>
                {isPre && (
                  <td className="p-2 text-xs">
                    {r.interviewOptIn ? r.interviewEmail : "—"}
                  </td>
                )}
                {answerable.map((q) => (
                  <td key={q.id} className="p-2 text-xs">
                    {formatAnswer(r.answers[q.id]) || (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {data.responses.length === 0 && (
              <tr>
                <td
                  colSpan={answerable.length + (isPre ? 4 : 3)}
                  className="p-6 text-center text-muted-foreground"
                >
                  No responses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
