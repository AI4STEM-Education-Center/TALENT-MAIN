"use client";

// The teacher's syllabus workspace: upload, watch extraction, review what was
// extracted, edit it directly, re-run extraction, or replace the PDF. Server
// data arrives as props; every action calls the API and then refreshes the
// route, so there is one source of truth and no client copy to drift.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import { SyllabusView } from "./SyllabusView";
import { SyllabusEditor } from "./SyllabusEditor";
import { SyllabusUpload } from "./SyllabusUpload";
import { AskAssistantButton } from "./AskAssistantButton";
import { formatDateTime } from "@/lib/format-date";
import type { SyllabusContent } from "@/lib/syllabus";
import type { TeacherSyllabusView } from "@/lib/syllabus-server";

const POLL_MS = 4_000;

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
}

function StatusBanner({ syllabus }: { syllabus: TeacherSyllabusView }) {
  if (syllabus.status === "EXTRACTING") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
        <Loader2 className="size-4 animate-spin" />
        Extracting course information and dates from{" "}
        {syllabus.originalName ?? "the PDF"}…
        {syllabus.content &&
          " The current version stays visible until it finishes."}
      </div>
    );
  }
  if (syllabus.status === "FAILED") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          Extraction failed: {syllabus.errorMessage ?? "unknown error"}.
          {syllabus.content && " Students still see the previous version."}
        </span>
      </div>
    );
  }
  if (syllabus.status === "PENDING_UPLOAD" && syllabus.content) {
    return (
      <p className="text-sm text-muted-foreground">
        A new version was started but never finished uploading. Students see the
        version below.
      </p>
    );
  }
  return null;
}

export function TeacherSyllabusPanel({
  classId,
  syllabus,
  today,
}: {
  classId: string;
  syllabus: TeacherSyllabusView | null;
  today: string;
}) {
  const { refresh } = useRouter();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/classes/${classId}/syllabus`;
  const extracting = syllabus?.status === "EXTRACTING";

  // Poll the server render while the worker runs; stops on its own once the
  // refreshed props say extraction is over.
  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [extracting, refresh]);

  /** Run one API call, then refresh the route. Resolves true on success. */
  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(content: SyllabusContent) {
    if (await run(() => send(base, "PUT", { content }))) setEditing(false);
  }

  async function retry() {
    if (
      syllabus?.content &&
      !(await confirm({
        title: "Re-run extraction?",
        description:
          "The syllabus will be read again from the PDF and replace the current content, including any edits you made.",
        confirmText: "Re-run",
      }))
    )
      return;
    await run(() => send(`${base}/retry`, "POST"));
  }

  async function remove() {
    if (
      !(await confirm({
        title: "Delete the syllabus?",
        description:
          "Students will no longer see it, and the assistant will stop answering from it.",
        confirmText: "Delete",
        variant: "destructive",
      }))
    )
      return;
    await run(() => send(base, "DELETE"));
  }

  if (editing && syllabus?.content) {
    return (
      <div className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <SyllabusEditor
          initial={syllabus.content}
          saving={busy}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {syllabus && <StatusBanner syllabus={syllabus} />}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {syllabus && (
        <div className="flex flex-wrap items-center gap-2">
          {syllabus.content && (
            <Button
              size="sm"
              onClick={() => setEditing(true)}
              disabled={busy || extracting}
            >
              <Pencil className="size-4" /> Edit
            </Button>
          )}
          {syllabus.hasFile && (
            <Button size="sm" variant="outline" asChild>
              <a href={`${base}/file`} target="_blank" rel="noreferrer">
                <FileText className="size-4" /> View PDF
              </a>
            </Button>
          )}
          {syllabus.canRetry && (
            <Button
              size="sm"
              variant="outline"
              onClick={retry}
              disabled={busy || extracting}
            >
              <RefreshCw className="size-4" /> Re-run extraction
            </Button>
          )}
          {syllabus.content && <AskAssistantButton />}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={remove}
            disabled={busy}
          >
            <Trash2 className="size-4" /> Delete
          </Button>
        </div>
      )}

      {syllabus?.content && (
        <p className="text-xs text-muted-foreground">
          {syllabus.editedAt
            ? `Edited ${formatDateTime(syllabus.editedAt)}`
            : syllabus.extractedAt &&
              `Extracted ${formatDateTime(syllabus.extractedAt)}`}
          {syllabus.originalName && ` · from ${syllabus.originalName}`}{" "}
          <AiMetricsLine metrics={syllabus.ai} />
        </p>
      )}

      {syllabus &&
        syllabus.warnings.length > 0 &&
        syllabus.status === "READY" && (
          <Card className="border-yellow-300 dark:border-yellow-800">
            <CardContent className="pt-4 text-sm">
              <p className="mb-1 flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4 text-yellow-600" /> Check these
                before students rely on them
              </p>
              <ul className="list-disc pl-6 text-muted-foreground">
                {syllabus.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

      {/* Available mid-extraction too: uploading the right file after the
          wrong one supersedes the run in progress. */}
      <SyllabusUpload
        classId={classId}
        replacing={Boolean(syllabus?.content)}
        onUploaded={refresh}
      />

      {syllabus?.content && (
        <SyllabusView content={syllabus.content} today={today} />
      )}
    </div>
  );
}
