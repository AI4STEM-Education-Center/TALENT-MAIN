"use client";

import { useId, useState } from "react";
import { Image as ImageIcon, ImageOff, ImagePlus, Maximize2, Plus, Trash2, Type, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MathText } from "@/components/ui/math-text";
import { normalizeNumericValue } from "@/lib/quiz-scoring";
import type { FigureBbox, StagedOption, StagedQuestion } from "@/lib/quiz-extraction";
import { MultiBoxCropper, type CropBox } from "./MultiBoxCropper";

export type PageImage = { pageNumber: number; url: string };

const TYPE_LABEL: Record<StagedQuestion["type"], string> = {
  MULTIPLE_CHOICE: "Multiple choice",
  MULTI_SELECT: "Multi-select",
  TRUE_FALSE: "True / False",
  NUMERIC: "Numeric",
};

const DEFAULT_FIGURE_BBOX: FigureBbox = { x: 0.08, y: 0.08, w: 0.5, h: 0.4 };

/** Letter shown for an answer choice (A, B, C, …) and reused as its crop-box label. */
function optionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `#${index + 1}`;
}

/** Staggered default crop box for a freshly-flagged image option so boxes don't stack. */
function defaultOptionBbox(order: number): FigureBbox {
  return { x: 0.1, y: Math.min(0.05 + order * 0.16, 0.8), w: 0.35, h: 0.14 };
}

/**
 * Local mirror of the server's commit-completeness rules. A figure or image
 * option with a still-pending crop (a bbox but no storage key) counts as
 * complete here, because the crop is drawn + uploaded during the commit step.
 * An image option with NO crop box yet is incomplete — there is nothing to crop.
 */
export function isQuestionComplete(q: StagedQuestion): boolean {
  if (q.type === "NUMERIC") {
    return normalizeNumericValue(q.numericAnswer) !== null;
  }
  if (q.options.length < 2) return false;
  if (q.options.some((o) => o.isCorrect === null)) return false;
  if (q.options.some((o) => o.isImage === true && !(o.imageBbox ?? o.imageStorageKey))) return false;
  const correct = q.options.filter((o) => o.isCorrect === true).length;
  if (q.type === "MULTI_SELECT") return correct >= 1;
  return correct === 1; // MULTIPLE_CHOICE / TRUE_FALSE
}

function pageImageFor(pages: PageImage[], pageNumber: number | null): string | null {
  if (pageNumber === null) return null;
  return pages.find((p) => p.pageNumber === pageNumber)?.url ?? null;
}

/**
 * The crop boxes a question needs (its figure + every image option), grouped by
 * the page each lives on. The page resolution matches the commit-time crop
 * (`figurePage ?? sourcePage`; an option's `imagePage` overrides) so a box drawn
 * here is read back against the same page image at commit. Module-scope + pure.
 */
function cropBoxesByPage(q: StagedQuestion): { page: number; boxes: CropBox[] }[] {
  const figurePage = q.figurePage ?? q.sourcePage;
  const entries: { page: number; box: CropBox }[] = [];
  if (q.hasFigure) {
    entries.push({ page: figurePage, box: { id: "figure", label: "Figure", bbox: q.figureBbox ?? DEFAULT_FIGURE_BBOX } });
  }
  let imageOrder = 0;
  q.options.forEach((o, oi) => {
    if (o.isImage !== true) return;
    entries.push({
      page: o.imagePage ?? figurePage,
      box: { id: `opt-${oi}`, label: optionLetter(oi), bbox: o.imageBbox ?? defaultOptionBbox(imageOrder) },
    });
    imageOrder += 1;
  });
  const byPage = new Map<number, CropBox[]>();
  for (const e of entries) {
    const list = byPage.get(e.page);
    if (list) list.push(e.box);
    else byPage.set(e.page, [e.box]);
  }
  return [...byPage.entries()].map(([page, boxes]) => ({ page, boxes }));
}

/**
 * Rendered-LaTeX preview box, captioned "Preview" so a teacher reads it as a
 * render of the input beside/above it rather than another editable field.
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
  const fieldId = useId();

  const pageGroups = cropBoxesByPage(q);
  const allBoxIds = pageGroups.flatMap((g) => g.boxes.map((b) => b.id));
  const [activeBoxId, setActiveBoxId] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  // Resolve the active box to one that still exists (boxes come and go as the
  // teacher toggles options); default to the first.
  const resolvedActiveId = activeBoxId && allBoxIds.includes(activeBoxId) ? activeBoxId : allBoxIds[0] ?? null;

  function setOptionText(oi: number, text: string) {
    onChange({ ...q, options: q.options.map((o, i) => (i === oi ? { ...o, text } : o)) });
  }

  function setOption(oi: number, patch: Partial<StagedOption>) {
    onChange({ ...q, options: q.options.map((o, i) => (i === oi ? { ...o, ...patch } : o)) });
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

  function toggleOptionIsImage(oi: number) {
    const o = q.options[oi];
    if (o.isImage === true) {
      setOption(oi, { isImage: false, imageBbox: null, imagePage: null, imageStorageKey: null, imageAlt: null });
    } else {
      const imageOrder = q.options.slice(0, oi).filter((x) => x.isImage === true).length;
      setOption(oi, { isImage: true, imageBbox: defaultOptionBbox(imageOrder), imageStorageKey: null });
    }
  }

  function removeFigure() {
    onChange({ ...q, hasFigure: false, figureBbox: null, figureStorageKey: null });
  }

  // Flag a figure for a question the extractor missed: drops in a default,
  // draggable crop box (on the source page) for the teacher to position. The
  // inverse of removeFigure; the box is cropped + uploaded during commit.
  function addFigure() {
    onChange({ ...q, hasFigure: true, figureBbox: q.figureBbox ?? DEFAULT_FIGURE_BBOX, figureStorageKey: null });
  }

  // A crop box moved: route it to the figure or the matching option. Editing a
  // crop invalidates any previously uploaded key for that target.
  function setBoxBbox(id: string, bbox: FigureBbox) {
    if (id === "figure") {
      onChange({ ...q, figureBbox: bbox, figureStorageKey: null });
      return;
    }
    const oi = Number(id.slice("opt-".length));
    if (!Number.isInteger(oi)) return;
    setOption(oi, { imageBbox: bbox, imageStorageKey: null });
  }

  const sourceUrl = pageImageFor(pageImages, q.sourcePage);
  const hasCrops = pageGroups.length > 0;

  function renderCroppers(large: boolean) {
    return (
      <div className="space-y-3">
        {pageGroups.map((g) => {
          const url = pageImageFor(pageImages, g.page);
          if (!url) {
            return (
              <p key={g.page} className="text-xs text-destructive">
                Source page {g.page} image unavailable for cropping.
              </p>
            );
          }
          return (
            <div key={g.page} className="space-y-1">
              {pageGroups.length > 1 && (
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Page {g.page}
                </span>
              )}
              <MultiBoxCropper
                pageUrl={url}
                boxes={g.boxes}
                activeId={resolvedActiveId}
                onSelect={setActiveBoxId}
                onChange={setBoxBbox}
                // Inline: fill the column (matching the plain source-page image).
                // Enlarged: shrink-to-fit so the page fits the dialog height and
                // the crop boxes stay aligned to the image.
                imgClassName={large ? "block max-h-[78vh] w-auto max-w-full" : "block w-full"}
                containerClassName={
                  large
                    ? undefined
                    : "relative block w-full touch-none select-none overflow-hidden rounded border"
                }
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Controls that float over the top-right of the source-page preview (the same
  // overlay treatment the plain source-page image uses): enlarge, plus an
  // add/remove-figure toggle so every question can gain or drop a figure crop.
  const overlayButton = "size-8 bg-background/80 shadow-sm backdrop-blur hover:bg-background";
  const figureControls = (
    <div className="absolute right-2 top-2 flex items-center gap-1">
      <Button size="icon" variant="secondary" onClick={() => setEnlarged(true)} aria-label="Enlarge page" className={overlayButton}>
        <Maximize2 className="size-4" />
      </Button>
      {q.hasFigure ? (
        <Button size="icon" variant="secondary" onClick={removeFigure} aria-label="Remove figure" title="Remove figure" className={overlayButton}>
          <ImageOff className="size-4" />
        </Button>
      ) : (
        <Button size="icon" variant="secondary" onClick={addFigure} aria-label="Add figure" title="Add figure" className={overlayButton}>
          <ImagePlus className="size-4" />
        </Button>
      )}
    </div>
  );

  return (
    <div className={`rounded-lg border p-4 space-y-3 ${complete ? "" : "border-amber-300 bg-amber-50/40 dark:border-amber-700/60 dark:bg-amber-950/20"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">Q{index + 1}</span>
          <Badge variant="outline" className="text-xs">{TYPE_LABEL[q.type]}</Badge>
          {q.needsReview && <Badge variant="warning" className="text-xs">Needs review</Badge>}
          {q.confidence < 0.7 && <Badge variant="warning" className="text-xs">Low confidence</Badge>}
          {!complete && <Badge variant="destructive" className="text-xs">Incomplete</Badge>}
        </div>
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove question ${index + 1}`}>
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>

      {q.needsReview && q.reviewNote && <p className="text-xs text-amber-700 dark:text-amber-300">{q.reviewNote}</p>}

      {/* Editing fields on the left; the source page is shown on the right (a
          draggable multi-box cropper when the question has a figure and/or image
          choices, otherwise a plain reference image). */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-text`} className="text-xs font-medium text-muted-foreground">Question text (LaTeX in $…$)</label>
            <Textarea id={`${fieldId}-text`} value={q.text} onChange={(e) => onChange({ ...q, text: e.target.value })} rows={3} />
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
              {q.options.map((opt, oi) => {
                const isImageOpt = opt.isImage === true;
                return (
                  <div key={oi} className="space-y-1">
                    <div className="flex items-end gap-2">
                      <div className="flex h-10 shrink-0 items-center gap-1">
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
                        <span className="font-mono text-xs text-muted-foreground">{optionLetter(oi)}</span>
                      </div>

                      {isImageOpt ? (
                        <div className="flex grow items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5">
                          <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                          <Input
                            value={opt.imageAlt ?? ""}
                            onChange={(e) => setOption(oi, { imageAlt: e.target.value || null })}
                            placeholder="Image label / caption (optional)"
                            className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                          />
                        </div>
                      ) : (
                        <Input value={opt.text} onChange={(e) => setOptionText(oi, e.target.value)} placeholder={`Option ${oi + 1}`} />
                      )}

                      {q.type !== "TRUE_FALSE" && (
                        <div className="flex h-10 shrink-0 items-center">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => toggleOptionIsImage(oi)}
                            aria-label={isImageOpt ? `Make option ${oi + 1} text` : `Make option ${oi + 1} an image`}
                            title={isImageOpt ? "Switch to text" : "Switch to image"}
                          >
                            {isImageOpt ? <Type className="size-3" /> : <ImageIcon className="size-3" />}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => removeOption(oi)} aria-label={`Remove option ${oi + 1}`}>
                            <X className="size-3" />
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Render preview on its own row below the input so long options
                        wrap to multiple lines instead of overflowing the column. */}
                    {!isImageOpt && opt.text.includes("$") && (
                      <MathPreview text={opt.text} className="pl-7" />
                    )}
                  </div>
                );
              })}
              {q.type !== "TRUE_FALSE" && (
                <Button size="sm" variant="ghost" onClick={addOption}>
                  <Plus className="size-3" /> Add option
                </Button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`${fieldId}-answer`} className="text-xs font-medium text-muted-foreground">Correct answer</label>
                <Input
                  id={`${fieldId}-answer`}
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
                <label htmlFor={`${fieldId}-unit`} className="text-xs font-medium text-muted-foreground">Unit (display only)</label>
                <Input
                  id={`${fieldId}-unit`}
                  value={q.numericUnit ?? ""}
                  onChange={(e) => onChange({ ...q, numericUnit: e.target.value || null })}
                  placeholder="supports $LaTeX$"
                />
              </div>
            </div>
          )}
        </div>

        {/* Source page — always visible next to the (often taller) editing column. */}
        <div className="space-y-2 self-start lg:sticky lg:top-4">
          {hasCrops ? (
            <>
              <span className="text-xs font-medium text-muted-foreground">
                {q.options.some((o) => o.isImage === true)
                  ? "Drag each labeled box onto its choice image"
                  : `Figure crop${q.figureCaption ? ` — ${q.figureCaption}` : ""}`}
              </span>
              {/* Image fills the column; enlarge + figure controls float over it
                  (matching the plain source-page image below). */}
              <div className="relative">
                {renderCroppers(false)}
                {figureControls}
              </div>
            </>
          ) : sourceUrl ? (
            <>
              <span className="text-xs font-medium text-muted-foreground">Source page {q.sourcePage}</span>
              {/* Image fills the column; the controls float over it so they
                  don't steal a row or shrink the page preview. */}
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={sourceUrl} alt={`Source page ${q.sourcePage}`} className="block w-full rounded border" />
                {figureControls}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No source page image available.</p>
          )}
        </div>
      </div>

      <Dialog open={enlarged} onOpenChange={setEnlarged}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Q{index + 1} — source page</DialogTitle>
          </DialogHeader>
          <div className="max-h-[82vh] overflow-auto">
            {hasCrops ? (
              renderCroppers(true)
            ) : sourceUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={sourceUrl} alt={`Source page ${q.sourcePage}`} className="mx-auto block max-h-[78vh] w-auto max-w-full" />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
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
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
          No answer key detected — set the correct answer for every question.
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
          {warnings.map((w, i) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- warnings is a static list of strings with no per-item state; index identity is stable enough
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
