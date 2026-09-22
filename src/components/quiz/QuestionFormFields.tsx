"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Check, X } from "lucide-react";
import type { AnswerMode } from "./quiz-editor-types";
import type { QuizEditorModel } from "./use-quiz-editor";

export function QuestionFormFields({ editor }: { editor: QuizEditorModel }) {
  const {
    savingQuestion,
    form,
    setForm,
    setAnswerMode,
    setOption,
    markCorrect,
    addOption,
    saveQuestion,
    editingQuestion,
    resetForm,
  } = editor;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="question-difficulty">Difficulty</Label>
        <select
          id="question-difficulty"
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={form.difficultyLevel}
          onChange={(e) =>
            setForm((p) => ({ ...p, difficultyLevel: e.target.value }))
          }
        >
          <option value="BEGINNER">Beginner</option>
          <option value="INTERMEDIATE">Intermediate</option>
          <option value="ADVANCED">Advanced</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="question-answer-type">Answer Type</Label>
        <select
          id="question-answer-type"
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={form.answerMode}
          onChange={(e) => setAnswerMode(e.target.value as AnswerMode)}
        >
          <option value="SINGLE_SELECT">Single correct answer</option>
          <option value="MULTI_SELECT">Select all that apply</option>
          <option value="NUMERIC">Numeric answer</option>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="question-text">Question Text</Label>
        <Textarea
          id="question-text"
          value={form.text}
          onChange={(e) => setForm((p) => ({ ...p, text: e.target.value }))}
          rows={3}
          placeholder="Enter the question..."
        />
      </div>
      {form.answerMode === "NUMERIC" ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label htmlFor="numeric-answer">Correct answer</Label>
            <Input
              id="numeric-answer"
              inputMode="decimal"
              value={form.answerNumeric}
              onChange={(e) =>
                setForm((p) => ({ ...p, answerNumeric: e.target.value }))
              }
              placeholder="e.g. 9.81"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="numeric-tolerance">Tolerance ±</Label>
            <Input
              id="numeric-tolerance"
              inputMode="decimal"
              value={form.answerTolerance}
              onChange={(e) =>
                setForm((p) => ({ ...p, answerTolerance: e.target.value }))
              }
              placeholder="auto (±0.5%, min 0.01)"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="answer-unit">Unit</Label>
            <Input
              id="answer-unit"
              value={form.answerUnit}
              onChange={(e) =>
                setForm((p) => ({ ...p, answerUnit: e.target.value }))
              }
              placeholder="display only, supports $LaTeX$"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Label>
            Options{" "}
            <span className="text-muted-foreground text-xs">
              (
              {form.answerMode === "MULTI_SELECT"
                ? "click boxes to mark all correct answers"
                : "click radio to mark correct"}
              )
            </span>
          </Label>
          {form.options.map((opt, i) => (
            <div key={opt.id} className="flex items-center gap-2">
              <button
                type="button"
                aria-label={
                  opt.isCorrect ? "Mark as incorrect" : "Mark as correct"
                }
                aria-pressed={opt.isCorrect}
                onClick={() => markCorrect(i)}
                className={`size-4 border-2 shrink-0 ${form.answerMode === "MULTI_SELECT" ? "rounded" : "rounded-full"} ${opt.isCorrect ? "bg-green-500 border-green-500" : "border-muted-foreground"}`}
              />
              {opt.imageUrl ? (
                // Image choice from the PDF pipeline: shown, not editable here.
                // Plain <img>: short-lived presigned S3 URL (see figure img below).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={opt.imageUrl}
                  alt={opt.imageAlt ?? `Option ${i + 1}`}
                  className="max-h-16 rounded border bg-white"
                />
              ) : opt.hasImage ? (
                // Stored crop whose preview failed to presign — still an image choice.
                <span className="text-sm text-muted-foreground italic">
                  Image choice (preview unavailable)
                </span>
              ) : (
                <Input
                  aria-label={`Option ${i + 1}`}
                  placeholder={`Option ${i + 1}`}
                  value={opt.text}
                  onChange={(e) => setOption(i, "text", e.target.value)}
                />
              )}
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={addOption}>
            <Plus className="size-3" /> Add option
          </Button>
        </div>
      )}
      <div className="flex gap-3">
        <Button onClick={saveQuestion} disabled={savingQuestion}>
          <Check className="size-4" /> {editingQuestion ? "Update" : "Save"}
        </Button>
        <Button variant="outline" onClick={resetForm}>
          <X className="size-4" /> Cancel
        </Button>
      </div>
    </>
  );
}
