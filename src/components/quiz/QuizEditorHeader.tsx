"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Check,
  Copy,
  X,
  Pencil,
  Eye,
  Download,
  Loader2,
  Sparkles,
} from "lucide-react";
import type { QuizDetail } from "./quiz-editor-types";
import type { QuizEditorModel } from "./use-quiz-editor";

export function QuizEditorHeader({
  editor,
  quiz,
  previewHref,
  listHref,
}: {
  editor: QuizEditorModel;
  quiz: QuizDetail;
  previewHref?: string;
  /** The quiz list route; a duplicate opens at `${listHref}/<copyId>`. */
  listHref: string;
}) {
  const {
    editingName,
    nameDraft,
    setNameDraft,
    saveName,
    setEditingName,
    topics,
    changeTopic,
    importPoolCopy,
    poolImportBusy,
    duplicateQuiz,
    duplicateBusy,
    generateSimulations,
    simBusy,
  } = editor;
  const readOnly = !quiz.editable;
  const isPoolQuiz = quiz.teacherId === null;
  const missingSimulations = quiz.questions.filter(
    (q) => !q.simulation || q.simulation.status === "FAILED",
  ).length;
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        {editingName ? (
          <div className="flex items-center gap-2">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="h-9 text-lg font-bold"
              autoFocus
            />
            <Button size="sm" variant="ghost" onClick={saveName}>
              <Check className="size-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditingName(false)}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : (
          <h1 className="text-3xl font-bold flex items-center gap-2">
            {quiz.name}
            {!readOnly && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNameDraft(quiz.name);
                  setEditingName(true);
                }}
                aria-label="Rename quiz"
              >
                <Pencil className="size-3" />
              </Button>
            )}
          </h1>
        )}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {isPoolQuiz && <Badge variant="secondary">Global pool</Badge>}
          <Badge variant="outline">
            {quiz.questions.length} question
            {quiz.questions.length !== 1 ? "s" : ""}
          </Badge>
          {readOnly ? (
            quiz.topic && <Badge variant="outline">{quiz.topic.name}</Badge>
          ) : (
            <select
              className="flex h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={quiz.topicId ?? ""}
              onChange={(e) => changeTopic(e.target.value)}
              aria-label="Topic"
            >
              <option value="">No topic</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {previewHref && quiz.questions.length > 0 && (
          <Button variant="outline" asChild>
            <Link href={previewHref} target="_blank" rel="noopener noreferrer">
              <Eye className="size-4" /> Preview as student
            </Link>
          </Button>
        )}
        {readOnly ? (
          <Button onClick={importPoolCopy} disabled={poolImportBusy}>
            <Download className="size-4" />{" "}
            {poolImportBusy ? "Importing…" : "Import to my quizzes"}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => duplicateQuiz(listHref)}
              disabled={duplicateBusy}
            >
              {duplicateBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Copy className="size-4" />
              )}
              {duplicateBusy ? "Duplicating…" : "Duplicate"}
            </Button>
            {missingSimulations > 0 && (
              <Button
                variant="outline"
                onClick={() =>
                  generateSimulations(
                    { scope: "quiz", quizId: quiz.id },
                    "quiz",
                  )
                }
                disabled={simBusy.has("quiz")}
              >
                {simBusy.has("quiz") ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Generate simulations ({missingSimulations})
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
