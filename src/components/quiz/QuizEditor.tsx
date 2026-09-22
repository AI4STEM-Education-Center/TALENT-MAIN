"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, ArrowLeft, FileQuestion } from "lucide-react";
import { GuardrailFeedbackButton } from "@/components/guardrails/GuardrailFeedbackButton";
import { SimulationPanel } from "@/components/simulation/SimulationPanel";
import { QuizVariants } from "./QuizVariants";
import { QuizPdfImport } from "./QuizPdfImport";
import { QuestionFormFields } from "./QuestionFormFields";
import { QuizQuestionCard } from "./QuizQuestionCard";
import { QuizEditorHeader } from "./QuizEditorHeader";
import { QtiImportCard } from "./QtiImportCard";
import { useQuizEditor } from "./use-quiz-editor";

interface QuizEditorProps {
  quizId: string;
  backHref: string;
  backLabel: string;
  previewHref?: string;
}

export function QuizEditor(props: QuizEditorProps) {
  return <QuizEditorContent key={props.quizId} {...props} />;
}

function QuizEditorContent({
  quizId,
  backHref,
  backLabel,
  previewHref,
}: QuizEditorProps) {
  const editor = useQuizEditor(quizId);
  const {
    quiz,
    loading,
    loadError,
    notFound,
    msg,
    guardrailEventId,
    pdfImportActive,
    setPdfImportActive,
    setMsg,
    refreshQuestions,
    editingQuestion,
    showForm,
    addFormRef,
    resetForm,
    setShowForm,
    openSimulationId,
    setOpenSimulationId,
  } = editor;
  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (loadError)
    return <div className="p-6 text-sm text-destructive">{loadError}</div>;
  if (notFound || !quiz)
    return <div className="p-6 text-muted-foreground">Quiz not found.</div>;

  const readOnly = !quiz.editable;
  return (
    <div className="max-w-6xl p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={backHref}>
          <ArrowLeft className="size-4" /> {backLabel}
        </Link>
      </Button>

      <QuizEditorHeader editor={editor} quiz={quiz} previewHref={previewHref} />

      {msg && (
        <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">
          {msg}
          <GuardrailFeedbackButton
            eventId={guardrailEventId}
            className="ml-2"
          />
        </div>
      )}

      {!readOnly && !pdfImportActive && (
        <QtiImportCard
          quizId={quizId}
          onImported={refreshQuestions}
          onMessage={setMsg}
        />
      )}

      {!readOnly && (
        <QuizVariants quizId={quiz.id} questions={quiz.questions} />
      )}

      {!readOnly && (
        <QuizPdfImport
          quizId={quiz.id}
          onCommitted={refreshQuestions}
          onActiveChange={setPdfImportActive}
        />
      )}

      {/* Questions List. The add/edit form renders inline here: in place of the
          edited question's card content, and as a "New Question" card at the end. */}
      <div className="space-y-3">
        {quiz.questions.map((q, i) => (
          <QuizQuestionCard
            key={q.id}
            q={q}
            index={i}
            readOnly={readOnly}
            editor={editor}
          />
        ))}

        {/* Add a new question inline, at the end of the list where it will
            land (order is createdAt asc): the "New Question" form when active,
            otherwise a trigger button in the same spot. */}
        {!readOnly &&
          (showForm && !editingQuestion ? (
            <div ref={addFormRef}>
              <Card className="ring-2 ring-primary">
                <CardHeader>
                  <CardTitle>New Question</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <QuestionFormFields editor={editor} />
                </CardContent>
              </Card>
            </div>
          ) : (
            !showForm &&
            quiz.questions.length > 0 && (
              <Button
                variant="outline"
                className="w-full border-dashed"
                onClick={() => {
                  resetForm();
                  setShowForm(true);
                }}
              >
                <Plus className="size-4" /> Add Question
              </Button>
            )
          ))}

        {/* Empty state, with an inline add trigger of its own. */}
        {quiz.questions.length === 0 && !(showForm && !editingQuestion) && (
          <Card>
            <CardContent className="text-center py-12 text-muted-foreground space-y-4">
              <FileQuestion className="size-10 mx-auto" />
              <p>
                {readOnly ? "This quiz has no questions." : "No questions yet."}
              </p>
              {!readOnly && (
                <Button
                  onClick={() => {
                    resetForm();
                    setShowForm(true);
                  }}
                >
                  <Plus className="size-4" /> Add Question
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Simulation viewer + feedback loop. Refresh on close so a feedback
          round's REVISING (or a finished revision's READY) badge shows. */}
      {openSimulationId && (
        <SimulationPanel
          simulationId={openSimulationId}
          canGiveFeedback={!readOnly}
          open
          onOpenChange={(open) => {
            if (!open) {
              setOpenSimulationId(null);
              refreshQuestions();
            }
          }}
        />
      )}
    </div>
  );
}
