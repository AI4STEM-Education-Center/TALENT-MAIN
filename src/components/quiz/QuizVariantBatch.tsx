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

/** Staged per-question revision reasons: versionId -> sourceQuestionId -> reason. */
type StagedRevisions = Record<string, Record<string, string>>;

type Staging = {
  staged: StagedRevisions;
  onToggle: (versionId: string, questionId: string) => void;
  onReason: (versionId: string, questionId: string, reason: string) => void;
};

const MIN_REASON = 3;
const canRevise = (v: Version) =>
  !isGenerating(v) && (v.status === "REVIEW" || v.status === "FAILED");
const bySlot = (a: Version, b: Version) =>
  (a.slotIndex ?? 0) - (b.slotIndex ?? 0) ||
  a.createdAt.localeCompare(b.createdAt);

function chunkPairs<T>(items: T[]) {
  const pairs: T[][] = [];
  for (let i = 0; i < items.length; i += 2) pairs.push(items.slice(i, i + 2));
  return pairs;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One generation round: a row per change mode, each comparing the original
 * with that mode's drafts two at a time. Save/approve actions sit directly on
 * each draft, and single questions can be sent back for revision in one batch.
 */
export function QuizVariantBatch({
  versions,
  stale,
  ...shared
}: Shared & { versions: Version[]; stale: boolean }) {
  const { act, busy } = shared;
  const [staged, setStaged] = useState<StagedRevisions>({});
  const onToggle = (versionId: string, questionId: string) =>
    setStaged((prev) => {
      const forVersion = { ...prev[versionId] };
      if (questionId in forVersion) delete forVersion[questionId];
      else forVersion[questionId] = "";
      const next = { ...prev, [versionId]: forVersion };
      if (Object.keys(forVersion).length === 0) delete next[versionId];
      return next;
    });
  const onReason = (versionId: string, questionId: string, reason: string) =>
    setStaged((prev) => ({
      ...prev,
      [versionId]: { ...prev[versionId], [questionId]: reason },
    }));
  // Only drafts that can still be revised count; one that started
  // regenerating or was approved meanwhile drops out of the batch.
  const pendingRevisions = versions
    .filter((v) => canRevise(v) && staged[v.id])
    .map((v) => ({
      versionId: v.id,
      questionRevisions: Object.entries(staged[v.id]).map(
        ([sourceQuestionId, reason]) => ({ sourceQuestionId, reason }),
      ),
    }))
    .filter((r) => r.questionRevisions.length > 0);
  const stagedQuestions = pendingRevisions.reduce(
    (sum, r) => sum + r.questionRevisions.length,
    0,
  );
  const tooShort = pendingRevisions.some((r) =>
    r.questionRevisions.some((q) => q.reason.trim().length < MIN_REASON),
  );
  async function submitRevisions() {
    const done = await act(
      {
        action: "revise_batch",
        batchId: versions[0]?.batchId,
        revisions: pendingRevisions.map((r) => ({
          versionId: r.versionId,
          questionRevisions: r.questionRevisions.map((q) => ({
            sourceQuestionId: q.sourceQuestionId,
            reason: q.reason.trim(),
          })),
        })),
      },
      "PATCH",
    );
    if (done) setStaged({});
  }
  const staging: Staging = { staged, onToggle, onReason };
  return (
    <div className="space-y-6">
      {stale && (
        <p role="status" className="text-sm text-amber-700">
          This exam changed after these versions were generated. Generate new
          versions to match the current questions.
        </p>
      )}
      {MODES.map((mode) => {
        const candidates = versions
          .filter((v) => v.variation === mode.value)
          .toSorted(bySlot);
        return candidates.length > 0 ? (
          <ModeRow
            key={mode.value}
            mode={mode}
            stale={stale}
            candidates={candidates}
            staging={staging}
            {...shared}
          />
        ) : null;
      })}
      {stagedQuestions > 0 && (
        <section
          aria-label="Staged revisions"
          className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-background/95 p-4 shadow-lg backdrop-blur"
        >
          <div className="space-y-1 text-sm">
            <p role="status" className="font-medium">
              {plural(stagedQuestions, "question")} staged for revision across{" "}
              {plural(pendingRevisions.length, "version")} — unflagged questions
              stay unchanged
            </p>
            {tooShort && (
              <p className="text-xs text-destructive">
                Each revision reason needs at least {MIN_REASON} characters.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setStaged({})}
            >
              Clear revisions
            </Button>
            <Button
              size="sm"
              disabled={busy || tooShort}
              onClick={() => void submitRevisions()}
            >
              <RefreshCw className="size-4" aria-hidden="true" /> Submit all
              revisions
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function ModeRow({
  mode,
  candidates,
  stale,
  staging,
  ...shared
}: Shared & {
  mode: (typeof MODES)[number];
  candidates: Version[];
  stale: boolean;
  staging: Staging;
}) {
  const { act, busy, purpose } = shared;
  const [editing, setEditing] = useState<string | null>(null);
  const reviewable = candidates.filter((v) => v.status === "REVIEW");
  const pending = candidates.some(isGenerating);
  const canAddMore =
    !stale &&
    !pending &&
    (purpose === "ALTERNATE" ||
      candidates.some((v) => v.status === "PUBLISHED"));
  async function saveAll(action: "publish" | "standalone") {
    for (const v of reviewable) await act({ versionId: v.id, action });
  }
  const both = reviewable.length === 2;
  const editVersion = candidates.find((v) => v.id === editing);
  return (
    <section
      aria-label={mode.label}
      className="overflow-hidden rounded-xl border"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-3">
        <h3 className="font-semibold">{mode.label}</h3>
        <div className="flex flex-wrap gap-2">
          {reviewable.length >= 2 && (
            <>
              <Button
                size="sm"
                variant={purpose === "ALTERNATE" ? "default" : "outline"}
                disabled={busy || stale}
                onClick={() => void saveAll("publish")}
              >
                {both
                  ? "Approve both as alternates"
                  : `Approve all ${reviewable.length} as alternates`}
              </Button>
              <Button
                size="sm"
                variant={purpose === "STANDALONE" ? "default" : "outline"}
                disabled={busy}
                onClick={() => void saveAll("standalone")}
              >
                {both
                  ? "Save both as standalone exams"
                  : `Save all ${reviewable.length} as standalone exams`}
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
      {chunkPairs(candidates).map((pair, block) => (
        <ComparisonBlock
          key={pair[0].id}
          slots={[pair[0], pair[1]]}
          first={block === 0}
          stale={stale}
          staging={staging}
          onEdit={setEditing}
          {...shared}
        />
      ))}
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

/** The original beside up to two drafts, question by question. */
function ComparisonBlock({
  slots,
  first,
  stale,
  staging,
  onEdit,
  ...shared
}: Shared & {
  slots: [Version, Version | undefined];
  first: boolean;
  stale: boolean;
  staging: Staging;
  onEdit: (versionId: string) => void;
}) {
  const { act, busy, questions } = shared;
  const { staged } = staging;
  return (
    <div className={first ? undefined : "border-t-4 border-muted"}>
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
                onEdit={() => onEdit(version.id)}
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
              if (!version) return <div key={slot} />;
              const variant = version.questions.find(
                (v) => v.sourceQuestionId === q.id,
              );
              const flagged = staged[version.id];
              return (
                <div
                  key={version.id}
                  role="group"
                  aria-label={`${version.name}, question ${index + 1}`}
                  className="min-w-0"
                >
                  <QuestionPreview
                    question={isGenerating(version) ? undefined : variant}
                    pending={isGenerating(version)}
                    check={
                      version.validation?.find(
                        (r) => r.sourceQuestionId === q.id,
                      )?.explanation
                    }
                  />
                  {canRevise(version) && (
                    <QuestionRevisionControl
                      version={version}
                      questionId={q.id}
                      questionNumber={index + 1}
                      reason={flagged?.[q.id]}
                      anyFlagged={!!flagged}
                      staging={staging}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="grid border-t lg:grid-cols-3 lg:divide-x">
        <div className="hidden p-4 text-sm text-muted-foreground lg:block">
          Flag single questions above, or tell the generator what to change in a
          whole draft; it is regenerated and re-verified.
        </div>
        {slots.map((version, slot) => (
          <div key={version?.id ?? slot} className="p-4">
            {version && canRevise(version) && (
              <CandidateFeedback version={version} act={act} busy={busy} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionRevisionControl({
  version,
  questionId,
  questionNumber,
  reason,
  anyFlagged,
  staging,
}: {
  version: Version;
  questionId: string;
  questionNumber: number;
  /** The staged reason, or undefined when this question is not flagged. */
  reason: string | undefined;
  anyFlagged: boolean;
  staging: Staging;
}) {
  const flagged = reason !== undefined;
  const id = `revision-${version.id}-${questionId}`;
  return (
    <div className="space-y-2 px-4 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={flagged ? "ghost" : "outline"}
          aria-pressed={flagged}
          onClick={() => staging.onToggle(version.id, questionId)}
        >
          {flagged ? "Cancel revision" : "Send back for revision"}
        </Button>
        {!flagged && anyFlagged && (
          <Badge variant="outline">Kept unchanged</Badge>
        )}
      </div>
      {flagged && (
        <div className="space-y-1">
          <label htmlFor={id} className="text-xs font-medium">
            What should change in question {questionNumber} of {version.name}?
          </label>
          <Textarea
            id={id}
            rows={2}
            maxLength={2000}
            value={reason}
            aria-invalid={reason.trim().length < MIN_REASON}
            onChange={(e) =>
              staging.onReason(version.id, questionId, e.target.value)
            }
            placeholder="What should change in this question? (e.g. Use whole numbers, change scenario)"
          />
        </div>
      )}
    </div>
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
          {version.totalCount && version.totalCount > 0
            ? `Generating and verifying (${version.completedCount ?? 0}/${version.totalCount} questions)…`
            : "Generating and verifying…"}
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
