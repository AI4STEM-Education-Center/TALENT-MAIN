"use client";
import Link from "next/link";
import { useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MathText } from "@/components/ui/math-text";
import type { VariantQuestion } from "@/lib/quiz-variants";
import {
  MODES,
  isGenerating,
  type Act,
  type SourceQuestion,
  type Version,
} from "./quiz-variant-types";

type Shared = {
  act: Act;
  busy: boolean;
  purpose: string;
  quizHrefBase: string;
  questions: SourceQuestion[];
};

/**
 * One generation round: a row per change mode, each comparing the original
 * with the two newest drafts side by side. Save/approve actions sit directly
 * on each draft so the teacher never has to dig for them.
 */
export function QuizVariantBatch({
  versions,
  stale,
  ...shared
}: Shared & { versions: Version[]; stale: boolean }) {
  return (
    <div className="space-y-6">
      {stale && (
        <p role="status" className="text-sm text-amber-700">
          This exam changed after these versions were generated. Generate new
          versions to match the current questions.
        </p>
      )}
      {MODES.map((mode) => (
        <ModeRow
          key={mode.value}
          mode={mode}
          stale={stale}
          // Two newest drafts for this mode, oldest first so slots stay put
          // when one of them is revised.
          candidates={versions
            .filter((v) => v.variation === mode.value)
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 2)
            .reverse()}
          {...shared}
        />
      ))}
    </div>
  );
}

function ModeRow({
  mode,
  candidates,
  stale,
  ...shared
}: Shared & {
  mode: (typeof MODES)[number];
  candidates: Version[];
  stale: boolean;
}) {
  const { act, busy, purpose, questions } = shared;
  const [editing, setEditing] = useState<string | null>(null);
  const reviewable = candidates.filter((v) => v.status === "REVIEW");
  const pending = candidates.some(isGenerating);
  const canAddMore =
    !stale &&
    !pending &&
    candidates.length > 0 &&
    (purpose === "ALTERNATE" ||
      candidates.some((v) => v.status === "PUBLISHED"));
  async function saveAll(action: "publish" | "standalone") {
    for (const v of reviewable) await act({ versionId: v.id, action });
  }
  const slots = [candidates[0], candidates[1]];
  const editVersion = candidates.find((v) => v.id === editing);
  return (
    <section
      aria-label={mode.label}
      className="overflow-hidden rounded-xl border"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-3">
        <h3 className="font-semibold">{mode.label}</h3>
        <div className="flex flex-wrap gap-2">
          {reviewable.length === 2 && (
            <>
              <Button
                size="sm"
                variant={purpose === "ALTERNATE" ? "default" : "outline"}
                disabled={busy}
                onClick={() => void saveAll("publish")}
              >
                Approve both as alternates
              </Button>
              <Button
                size="sm"
                variant={purpose === "STANDALONE" ? "default" : "outline"}
                disabled={busy}
                onClick={() => void saveAll("standalone")}
              >
                Save both as standalone exams
              </Button>
            </>
          )}
          {canAddMore && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(
                  {
                    name: "Version",
                    variation: mode.value,
                    count: 2,
                    objectives: candidates[0].objectives,
                    batchId: candidates[0].batchId,
                  },
                  "POST",
                )
              }
            >
              Generate two more
            </Button>
          )}
        </div>
      </header>
      <div className="grid divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <div className="p-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Original
        </div>
        {slots.map((version, slot) => (
          <div key={version?.id ?? slot} className="space-y-2 p-4">
            {version ? (
              <CandidateHeader
                version={version}
                stale={stale}
                onEdit={() => setEditing(version.id)}
                {...shared}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No draft in this slot.
              </p>
            )}
          </div>
        ))}
      </div>
      {questions.map((q, index) => (
        <div key={q.id} className="border-t">
          <p className="bg-muted/20 px-4 py-2 text-sm font-medium">
            Question {index + 1}
          </p>
          <div className="grid divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
            <QuestionPreview question={q} />
            {slots.map((version, slot) => {
              const variant = version?.questions.find(
                (v) => v.sourceQuestionId === q.id,
              );
              return (
                <QuestionPreview
                  key={version?.id ?? slot}
                  question={
                    version && !isGenerating(version) ? variant : undefined
                  }
                  pending={!!version && isGenerating(version)}
                  check={
                    version?.validation?.find(
                      (r) => r.sourceQuestionId === q.id,
                    )?.explanation
                  }
                />
              );
            })}
          </div>
        </div>
      ))}
      <div className="grid border-t lg:grid-cols-3 lg:divide-x">
        <div className="hidden p-4 text-sm text-muted-foreground lg:block">
          Tell the generator what to change; the draft is regenerated and
          re-verified.
        </div>
        {slots.map((version, slot) => (
          <div key={version?.id ?? slot} className="p-4">
            {version &&
              (version.status === "REVIEW" || version.status === "FAILED") && (
                <CandidateFeedback version={version} act={act} busy={busy} />
              )}
          </div>
        ))}
      </div>
      {editVersion && (
        <VariantEditor
          key={editVersion.id}
          version={editVersion}
          busy={busy}
          act={act}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function CandidateHeader({
  version,
  act,
  busy,
  purpose,
  quizHrefBase,
  stale,
  onEdit,
}: Shared & { version: Version; stale: boolean; onEdit: () => void }) {
  const save = (action: "publish" | "standalone") =>
    void act({ versionId: version.id, action });
  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {version.name}
      </p>
      {isGenerating(version) && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Generating and verifying…
        </p>
      )}
      {version.status === "REVIEW" && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={purpose === "ALTERNATE" ? "default" : "outline"}
            disabled={busy || stale}
            onClick={() => save("publish")}
          >
            <Check className="size-4" aria-hidden="true" /> Approve as alternate
          </Button>
          <Button
            size="sm"
            variant={purpose === "STANDALONE" ? "default" : "outline"}
            disabled={busy}
            onClick={() => save("standalone")}
          >
            Save as standalone exam
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
        </div>
      )}
      {version.status === "FAILED" && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {version.error ?? "Generation failed."}
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void act({ versionId: version.id, action: "retry" })}
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Regenerate
          </Button>
        </div>
      )}
      {version.status === "PUBLISHED" && (
        <Badge variant="success">Approved as alternate</Badge>
      )}
      {version.status === "RETIRED" && <Badge variant="outline">Retired</Badge>}
      {version.status === "STANDALONE" && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="success">Saved as standalone exam</Badge>
          {version.standaloneQuiz && (
            <Link
              className="text-sm underline"
              href={`${quizHrefBase}/${version.standaloneQuiz.id}`}
            >
              Open {version.standaloneQuiz.name}
            </Link>
          )}
        </div>
      )}
    </>
  );
}

function CandidateFeedback({
  version,
  act,
  busy,
}: {
  version: Version;
  act: Act;
  busy: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const id = `feedback-${version.id}`;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        Feedback for {version.name}
      </label>
      <Textarea
        id={id}
        rows={2}
        maxLength={2000}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="e.g. Use smaller whole numbers in question 2."
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !feedback.trim()}
          onClick={() =>
            void act({
              versionId: version.id,
              action: "revise",
              feedback: feedback.trim(),
            })
          }
        >
          Regenerate with feedback
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act({ versionId: version.id, action: "discard" })}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

export function QuestionPreview({
  question,
  pending = false,
  check,
}: {
  question?: SourceQuestion & { solution?: string };
  pending?: boolean;
  check?: string;
}) {
  return (
    <div className="min-w-0 space-y-4 p-4">
      {question ? (
        <>
          <MathText text={question.text} />
          <ul className="space-y-2">
            {question.options.map((option, i) => (
              <li
                key={option.id ?? option.text}
                className={`flex gap-2 rounded-lg border p-2 text-sm ${option.isCorrect ? "border-emerald-500/40 bg-emerald-500/10" : "bg-background"}`}
              >
                <span className="font-medium">
                  {String.fromCharCode(65 + i)}.
                </span>
                <MathText text={option.text} />
                {option.isCorrect && (
                  <span className="ml-auto text-xs font-medium">Correct</span>
                )}
              </li>
            ))}
          </ul>
          {question.answerMode === "NUMERIC" && (
            <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
              Answer: {question.answerNumeric} {question.answerUnit}
            </p>
          )}
          {question.solution && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                Solution & independent check
              </summary>
              <div className="mt-2 space-y-2">
                <MathText text={question.solution} />
                {check && (
                  <p className="text-muted-foreground">Check: {check}</p>
                )}
              </div>
            </details>
          )}
        </>
      ) : (
        <div
          className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
          role="status"
        >
          {pending ? "Generating a verified draft…" : "No draft to show."}
        </div>
      )}
    </div>
  );
}

/** Hand-edit a draft's text and answer key; saving re-runs verification. */
function VariantEditor({
  version,
  busy,
  act,
  onClose,
}: {
  version: Version;
  busy: boolean;
  act: Act;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<VariantQuestion[]>(version.questions);
  function update(id: string, patch: Partial<VariantQuestion>) {
    setDraft((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }
  return (
    <div className="space-y-4 border-t bg-muted/10 p-4">
      <h4 className="font-semibold">Edit {version.name}</h4>
      {draft.map((q, i) => (
        <div key={q.id} className="space-y-2 border-t pt-3">
          <label className="block text-sm">
            Question {i + 1}
            <Textarea
              value={q.text}
              onChange={(e) => update(q.id, { text: e.target.value })}
            />
          </label>
          {q.options.map((option) => (
            <div key={option.id} className="flex items-center gap-2">
              <input
                type="radio"
                aria-label={`Mark ${option.text} correct`}
                name={`correct-${version.id}-${q.id}`}
                checked={option.isCorrect}
                onChange={() =>
                  update(q.id, {
                    options: q.options.map((o) => ({
                      ...o,
                      isCorrect: o.id === option.id,
                    })),
                  })
                }
              />
              <Input
                aria-label="Answer choice"
                value={option.text}
                onChange={(e) =>
                  update(q.id, {
                    options: q.options.map((o) =>
                      o.id === option.id ? { ...o, text: e.target.value } : o,
                    ),
                  })
                }
              />
            </div>
          ))}
          {q.answerMode === "NUMERIC" && (
            <label className="block text-sm">
              Correct number
              <Input
                type="number"
                step="any"
                value={q.answerNumeric ?? ""}
                onChange={(e) =>
                  update(q.id, {
                    answerNumeric:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </label>
          )}
          <label className="block text-sm">
            Worked solution
            <Textarea
              value={q.solution}
              onChange={(e) => update(q.id, { solution: e.target.value })}
            />
          </label>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            const saved = await act({
              versionId: version.id,
              action: "edit",
              questions: draft,
            });
            if (saved) onClose();
          }}
        >
          Save and re-verify
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
