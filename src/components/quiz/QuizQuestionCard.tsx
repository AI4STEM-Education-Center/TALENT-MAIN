"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MathText } from "@/components/ui/math-text";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import { SimulationStatusBadge } from "@/components/simulation/SimulationStatusBadge";
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Pencil,
  Trash2,
  Atom,
  Eye,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { QuestionFormFields } from "./QuestionFormFields";
import type { Question, QuestionSimulation } from "./quiz-editor-types";
import type { QuizEditorModel } from "./use-quiz-editor";

/** A simulation the viewer dialog can meaningfully open (artifact or a decline). */
function simulationViewable(
  sim: QuestionSimulation | null | undefined,
): sim is QuestionSimulation {
  return Boolean(sim && (sim.hasContent || sim.status === "DECLINED"));
}

type QuestionProps = {
  q: Question;
  readOnly: boolean;
  editor: QuizEditorModel;
};
function QuestionSimulationActions({ q, readOnly, editor }: QuestionProps) {
  const sim = q.simulation;
  const viewable = simulationViewable(sim);
  if (readOnly && !viewable) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 border-t pt-2">
      <span className="mr-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Atom className="size-3" /> Simulation
      </span>
      {viewable && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => editor.setOpenSimulationId(sim.id)}
        >
          <Eye className="size-3" /> View
        </Button>
      )}
      {!readOnly && (
        <>
          <GenerateSimulationButton q={q} editor={editor} />
          {sim && (
            <Button
              size="sm"
              variant="ghost"
              disabled={editor.simBusyFor(q.id)}
              aria-label="Delete simulation"
              onClick={() => editor.deleteSimulation(q)}
            >
              <Trash2 className="size-3 text-destructive" />
            </Button>
          )}
        </>
      )}
      <SimulationNotice simulation={sim} />
    </div>
  );
}

function GenerateSimulationButton({
  q,
  editor,
}: Pick<QuestionProps, "q" | "editor">) {
  const sim = q.simulation;
  const busy = editor.simBusyFor(q.id);
  const needsGeneration = !sim || sim.status === "FAILED";
  const inProgress = sim?.status === "PENDING" || sim?.status === "REVISING";
  const label = needsGeneration
    ? sim
      ? "Retry"
      : "Generate"
    : inProgress
      ? "Restart"
      : "Regenerate";
  const generate = () =>
    needsGeneration
      ? editor.generateSimulations(
          { scope: "question", questionId: q.id },
          `q:${q.id}`,
        )
      : editor.regenerateSimulation(q);
  return (
    <Button
      size="sm"
      variant={needsGeneration ? "outline" : "ghost"}
      disabled={busy}
      onClick={generate}
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : needsGeneration ? (
        <Sparkles className="size-3" />
      ) : (
        <RefreshCw className="size-3" />
      )}
      {label}
    </Button>
  );
}

function SimulationNotice({
  simulation,
}: {
  simulation: QuestionSimulation | null | undefined;
}) {
  if (simulation?.status === "DECLINED" && simulation.declineReason)
    return (
      <p className="w-full text-xs italic text-muted-foreground">
        {simulation.declineReason}
      </p>
    );
  if (simulation?.status === "FAILED" && simulation.errorMessage)
    return (
      <p className="w-full text-xs text-destructive">
        {simulation.errorMessage}
      </p>
    );
  return null;
}

export function QuizQuestionCard({
  q,
  index: i,
  total,
  readOnly,
  editor,
}: QuestionProps & { index: number; total: number }) {
  const {
    editingQuestion,
    startEdit,
    deleteQuestion,
    reorderBusy,
    moveQuestion,
    draggedQuestionId,
    setDraggedQuestionId,
    dropQuestion,
  } = editor;
  const [dragOver, setDragOver] = useState(false);
  // Reordering is off while any question is open in the form, so the inline
  // editor never jumps out from under the teacher.
  const canReorder = !readOnly && !editingQuestion && total > 1;
  const dropTarget =
    canReorder && draggedQuestionId !== null && draggedQuestionId !== q.id;
  return (
    <Card
      className={
        editingQuestion?.id === q.id
          ? "ring-2 ring-primary"
          : dragOver && dropTarget
            ? "ring-2 ring-primary/60"
            : draggedQuestionId === q.id
              ? "opacity-50"
              : undefined
      }
      onDragOver={(e) => {
        if (!dropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!dropTarget) return;
        e.preventDefault();
        setDragOver(false);
        dropQuestion(q.id);
      }}
    >
      <CardContent className="p-4">
        {!readOnly && editingQuestion?.id === q.id ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground font-mono">
                Q{i + 1}
              </span>
              <span className="text-sm font-semibold">Editing question</span>
            </div>
            <QuestionFormFields editor={editor} />
          </div>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <QuestionMetadata q={q} index={i} />
              {q.title && <p className="text-sm font-semibold">{q.title}</p>}
              <p className="font-medium">
                <MathText text={q.text} />
              </p>
              {q.simulation && (
                <AiMetricsLine
                  metrics={q.simulation.aiMetrics}
                  prefix="Generated by "
                  className="block text-xs text-muted-foreground"
                />
              )}
              {q.figureUrl && (
                // Plain <img>: the src is a short-lived presigned S3 URL, not a
                // static asset, so next/image can't optimize it. Mirrors
                // QuizReviewResult's presigned-image img.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={q.figureUrl}
                  className="max-h-24 rounded border"
                  alt={q.figureAlt ?? "Question figure"}
                />
              )}
              <QuestionAnswer q={q} />
              <QuestionFeedback q={q} />
              <QuestionSimulationActions
                q={q}
                readOnly={readOnly}
                editor={editor}
              />
            </div>
            {!readOnly && (
              <div className="flex gap-1 shrink-0">
                {canReorder && (
                  <>
                    <button
                      type="button"
                      draggable={!reorderBusy}
                      disabled={reorderBusy}
                      aria-label={`Drag question ${i + 1} to reorder; the arrow buttons are an alternative`}
                      className="cursor-grab touch-none rounded p-2 hover:bg-muted"
                      onDragStart={(e) => {
                        setDraggedQuestionId(q.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", `Q${i + 1}`);
                      }}
                      onDragEnd={() => setDraggedQuestionId(null)}
                    >
                      <GripVertical className="size-3 pointer-events-none" />
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move question ${i + 1} up`}
                      disabled={reorderBusy || i === 0}
                      onClick={() => moveQuestion(q.id, -1)}
                    >
                      <ArrowUp className="size-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move question ${i + 1} down`}
                      disabled={reorderBusy || i === total - 1}
                      onClick={() => moveQuestion(q.id, 1)}
                    >
                      <ArrowDown className="size-3" />
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Edit question"
                  onClick={() => startEdit(q)}
                >
                  <Pencil className="size-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete question"
                  onClick={() => deleteQuestion(q.id)}
                >
                  <Trash2 className="size-3 text-destructive" />
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuestionMetadata({ q, index: i }: { q: Question; index: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground font-mono">Q{i + 1}</span>
      <Badge variant="outline" className="text-xs">
        {q.difficultyLevel}
      </Badge>
      <Badge variant="outline" className="text-xs">
        {q.answerMode === "NUMERIC"
          ? "Numeric"
          : q.answerMode === "MULTI_SELECT"
            ? "Multi-select"
            : "Single-select"}
      </Badge>
      {q.sourceQuestionId && (
        <Badge variant="secondary" className="text-xs">
          {q.sourceQuestionId}
        </Badge>
      )}
      {q.simulation && <SimulationStatusBadge status={q.simulation.status} />}
    </div>
  );
}

function QuestionFeedback({ q }: { q: Question }) {
  return (
    <>
      {(q.points || q.feedbackGeneral) && (
        <div className="text-xs text-muted-foreground space-y-1">
          {q.points ? <p>Points: {q.points}</p> : null}
          {q.feedbackGeneral ? <p>Feedback: {q.feedbackGeneral}</p> : null}
        </div>
      )}
    </>
  );
}

function QuestionAnswer({ q }: { q: Question }) {
  return q.answerMode === "NUMERIC" ? (
    <div className="text-sm text-green-700 font-medium space-y-1">
      {q.answerNumeric != null && (
        <p>
          Answer: {q.answerNumeric}
          {q.answerUnit ? " " : ""}
          {q.answerUnit ? <MathText text={q.answerUnit} /> : null}
        </p>
      )}
      {q.answerTolerance != null && (
        <p className="text-muted-foreground">± {q.answerTolerance}</p>
      )}
    </div>
  ) : (
    <div className="space-y-1">
      {q.options.map((opt) => (
        <div
          key={opt.id}
          className={`text-sm flex items-center gap-2 ${opt.isCorrect ? "text-green-700 font-medium" : "text-muted-foreground"}`}
        >
          <span
            className={`size-3 rounded-full shrink-0 ${opt.isCorrect ? "bg-green-500" : "bg-muted-foreground/30"}`}
          />
          {opt.imageUrl ? (
            // Plain <img>: short-lived presigned S3 URL (see figure img above).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={opt.imageUrl}
              alt={opt.imageAlt ?? "Answer choice"}
              className="max-h-20 rounded border bg-white"
            />
          ) : (
            <MathText text={opt.text} />
          )}
        </div>
      ))}
    </div>
  );
}
