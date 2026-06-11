"use client";

import { Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MathText } from "@/components/ui/math-text";
import { normalizeNumericValue } from "@/lib/quiz-scoring";
import type { FigureBbox, StagedQuestion } from "@/lib/quiz-extraction";
import { FigureCropper } from "./FigureCropper";

export type PageImage = { pageNumber: number; url: string };

const TYPE_LABEL: Record<StagedQuestion["type"], string> = {
  MULTIPLE_CHOICE: "Multiple choice",
  MULTI_SELECT: "Multi-select",
  TRUE_FALSE: "True / False",
  NUMERIC: "Numeric",
};

/**
 * Local mirror of the server's commit-completeness rules. A figure with a still
 * pending crop (hasFigure but no figureStorageKey) counts as complete here,
 * because the crop is drawn + uploaded during the commit step.
 */
export function isQuestionComplete(q: StagedQuestion): boolean {
  if (q.type === "NUMERIC") {
    return normalizeNumericValue(q.numericAnswer) !== null;
  }
  if (q.options.length < 2) return false;
  if (q.options.some((o) => o.isCorrect === null)) return false;
  const correct = q.options.filter((o) => o.isCorrect === true).length;
  if (q.type === "MULTI_SELECT") return correct >= 1;
  return correct === 1; // MULTIPLE_CHOICE / TRUE_FALSE
}

function pageImageFor(pages: PageImage[], pageNumber: number | null): string | null {
  if (pageNumber === null) return null;
  return pages.find((p) => p.pageNumber === pageNumber)?.url ?? null;
}

/**
 * Rendered-LaTeX preview box, captioned "Preview" so a teacher reads it as a
 * render of the input beside/above it rather than another editable field.
 *
 * `inline` sizes the box to one input row (h-10) so it lines up with the option
 * Input it sits beside; the caption still rides above it. The default (block)
 * variant grows with its content and is used under the multi-line question text.
 */
function MathPreview({ text, className, inline }: { text: string; className?: string; inline?: boolean }) {
  return (
    <div className={className}>
      <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Preview</span>
      <div
        className={
          inline
            ? "flex h-10 min-w-24 items-center overflow-x-auto rounded-md border bg-muted/30 px-3 text-sm"
            : "rounded border bg-muted/30 p-2 text-sm"
        }
      >
        <MathText text={text} />
      </div>
    </div>
  );
}

function QuestionCard({
  q,
  index,
  pageImages,
  onChange,
  onRemove,
}: {
  q: StagedQuestion;
  index: number;
  pageImages: PageImage[];
  onChange: (next: StagedQuestion) => void;
  onRemove: () => void;
}) {
  const complete = isQuestionComplete(q);
  const isChoice = q.type !== "NUMERIC";

  function setOptionText(oi: number, text: string) {
    onChange({ ...q, options: q.options.map((o, i) => (i === oi ? { ...o, text } : o)) });
  }

  function toggleCorrect(oi: number) {
    if (q.type === "MULTI_SELECT") {
      onChange({
        ...q,
        options: q.options.map((o, i) => (i === oi ? { ...o, isCorrect: o.isCorrect === true ? false : true } : o)),
      });
    } else {
      // Radio semantics: selecting one clears the others (MULTIPLE_CHOICE / TRUE_FALSE).
      onChange({ ...q, options: q.options.map((o, i) => ({ ...o, isCorrect: i === oi })) });
    }
  }

  function addOption() {
    onChange({ ...q, options: [...q.options, { text: "", isCorrect: q.type === "MULTI_SELECT" ? false : null }] });
  }

  function removeOption(oi: number) {
    onChange({ ...q, options: q.options.filter((_, i) => i !== oi) });
  }

  function removeFigure() {
    onChange({ ...q, hasFigure: false, figureBbox: null, figureStorageKey: null });
  }

  function setBbox(bbox: FigureBbox) {
    // Editing the crop invalidates any previously uploaded key.
    onChange({ ...q, figureBbox: bbox, figureStorageKey: null });
  }

  const sourceUrl = pageImageFor(pageImages, q.sourcePage);
  const figureUrl = pageImageFor(pageImages, q.figurePage ?? q.sourcePage);
  const figureBbox: FigureBbox = q.figureBbox ?? { x: 0.1, y: 0.1, w: 0.5, h: 0.4 };

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${complete ? "" : "border-amber-300 bg-amber-50/40"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">Q{index + 1}</span>
          <Badge variant="outline" className="text-xs">{TYPE_LABEL[q.type]}</Badge>
          {q.needsReview && (
            <Badge variant="warning" className="text-xs">Needs review</Badge>
          )}
          {q.confidence < 0.7 && (
            <Badge variant="warning" className="text-xs">Low confidence</Badge>
          )}
          {!complete && <Badge variant="destructive" className="text-xs">Incomplete</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove question ${index + 1}`}>
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>

      {q.needsReview && q.reviewNote && <p className="text-xs text-amber-700">{q.reviewNote}</p>}

      {/* Editing fields on the left; the source page is always shown on the right
          (a draggable figure crop when the question has a figure, otherwise a
          plain reference image) so the teacher never has to expand a toggle. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Question text (LaTeX in $…$)</label>
            <Textarea value={q.text} onChange={(e) => onChange({ ...q, text: e.target.value })} rows={3} />
            <MathPreview text={q.text} />
          </div>

          {isChoice ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                Options{" "}
                <span className="font-normal">
                  ({q.type === "MULTI_SELECT" ? "check all correct" : "select the one correct"})
                </span>
              </label>
              {/* items-end so the rendered preview lines up with the Input row;
                  its "Preview" caption then rides above without nudging the
                  controls. The radio + remove buttons get their own h-10 box so
                  they stay vertically centered on the input. */}
              {q.options.map((opt, oi) => (
                <div key={oi} className="flex items-end gap-2">
                  <div className="flex h-10 shrink-0 items-center">
                    <button
                      type="button"
                      aria-label={opt.isCorrect ? "Marked correct" : "Mark correct"}
                      aria-pressed={opt.isCorrect === true}
                      onClick={() => toggleCorrect(oi)}
                      className={`size-4 border-2 ${q.type === "MULTI_SELECT" ? "rounded" : "rounded-full"} ${
                        opt.isCorrect === true
                          ? "border-green-500 bg-green-500"
                          : opt.isCorrect === null
                            ? "border-amber-400"
                            : "border-muted-foreground"
                      }`}
                    />
                  </div>
                  <Input value={opt.text} onChange={(e) => setOptionText(oi, e.target.value)} placeholder={`Option ${oi + 1}`} />
                  {/* Rendered preview only earns its space for LaTeX; for plain
                      text (e.g. True/False) it just echoed the input, so omit it. */}
                  {opt.text.includes("$") && <MathPreview text={opt.text} inline className="hidden shrink-0 sm:block" />}
                  {q.type !== "TRUE_FALSE" && (
                    <div className="flex h-10 shrink-0 items-center">
                      <Button size="sm" variant="ghost" onClick={() => removeOption(oi)} aria-label={`Remove option ${oi + 1}`}>
                        <X className="size-3" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {q.type !== "TRUE_FALSE" && (
                <Button size="sm" variant="ghost" onClick={addOption}>
                  <Plus className="size-3" /> Add option
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Correct answer</label>
                <Input
                  inputMode="decimal"
                  value={q.numericAnswer ?? ""}
                  onChange={(e) => onChange({ ...q, numericAnswer: normalizeNumericValue(e.target.value) })}
                  placeholder="e.g. 9.81"
                />
                {q.numericAnswerText && (
                  <p className="text-xs text-muted-foreground">Printed answer: {q.numericAnswerText}</p>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Unit (display only)</label>
                <Input
                  value={q.numericUnit ?? ""}
                  onChange={(e) => onChange({ ...q, numericUnit: e.target.value || null })}
                  placeholder="supports $LaTeX$"
                />
              </div>
            </div>
          )}
        </div>

        {/* Source page — always visible, kept in view next to the (often taller)
            editing column on wide screens. */}
        <div className="space-y-2 self-start lg:sticky lg:top-4">
          {q.hasFigure ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Figure crop {q.figureCaption ? `— ${q.figureCaption}` : ""}
                </span>
                <Button size="sm" variant="ghost" onClick={removeFigure}>Remove figure</Button>
              </div>
              {figureUrl ? (
                <FigureCropper pageUrl={figureUrl} bbox={figureBbox} onChange={setBbox} />
              ) : (
                <p className="text-xs text-destructive">Source page image unavailable for cropping.</p>
              )}
            </>
          ) : sourceUrl ? (
            <>
              <span className="text-xs font-medium text-muted-foreground">Source page {q.sourcePage}</span>
              {/* Plain <img>: short-lived presigned S3 URL, not a static asset, so
                  next/image can't optimize it. Mirrors QuizReviewResult. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sourceUrl} alt={`Source page ${q.sourcePage}`} className="max-h-[36rem] w-auto max-w-full rounded border" />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No source page image available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Review list: the answer-key banner + warnings + one editable card per staged
 * question. All editing is lifted to the parent via `onChange` (a per-index
 * replace), keeping this component free of flow/network concerns.
 */
export function QuizPdfReview({
  questions,
  hasAnswerKey,
  warnings,
  pageImages,
  onChangeQuestion,
  onRemoveQuestion,
}: {
  questions: StagedQuestion[];
  hasAnswerKey: boolean;
  warnings: string[];
  pageImages: PageImage[];
  onChangeQuestion: (index: number, next: StagedQuestion) => void;
  onRemoveQuestion: (index: number) => void;
}) {
  return (
    <div className="space-y-4">
      {!hasAnswerKey && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          No answer key detected — set the correct answer for every question.
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {questions.map((q, i) => (
        <QuestionCard
          key={i}
          q={q}
          index={i}
          pageImages={pageImages}
          onChange={(next) => onChangeQuestion(i, next)}
          onRemove={() => onRemoveQuestion(i)}
        />
      ))}
    </div>
  );
}
