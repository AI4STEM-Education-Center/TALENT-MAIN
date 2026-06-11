"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, XCircle, RotateCcw } from "lucide-react";
import { ExamResultsView } from "@/components/student/ExamResultsView";
import { MathText } from "@/components/ui/math-text";
import { buildReviewSnapshot, RESULT_STATUS } from "@/lib/exam-results";
import { normalizeNumericValue } from "@/lib/quiz-scoring";

interface Option { id: string; text: string; isCorrect?: boolean }
interface Question {
  id: string;
  text: string;
  answerMode: string; // "SINGLE_SELECT" | "MULTI_SELECT" | "NUMERIC"
  answerUnit?: string | null;
  figureUrl?: string | null;
  figureAlt?: string | null;
  // NUMERIC grading data — present only in the post-submission (PATCH) payload.
  answerNumeric?: number | null;
  answerTolerance?: number | null;
  options: Option[];
}
interface QuizResult {
  score: number;
  correct: number;
  total: number;
  questions: Question[];
  answers: { questionId: string; selectedOptionId: string | null; selectedOptionIds?: string[]; numericValue?: number | null; isCorrect: boolean }[];
}

type Phase = "loading" | "quiz" | "results" | "error";

export default function QuizPage() {
  const { id: classId, quizId } = useParams<{ id: string; quizId: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [attemptId, setAttemptId] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // Raw, unparsed NUMERIC field strings keyed by question id. Kept raw (rather
  // than parsed numbers) so partial input like "-" or "3." types naturally;
  // normalizeNumericValue is applied wherever a real number is needed.
  const [numericInputs, setNumericInputs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // startQuiz is wrapped in useCallback so it is a stable dependency for the
  // mount effect (exhaustive-deps): it only depends on classId/quizId, which
  // come from route params and never change for a mounted page. The ref guard
  // keeps the auto-start to exactly one run even under React 19 StrictMode's
  // intentional double-invoke in dev. The button-driven "Try again" / "Retry"
  // callers reuse the same function and are unaffected by the guard.
  const startedRef = useRef(false);

  const startQuiz = useCallback(async () => {
    setPhase("loading");
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, quizId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setPhase("error"); return; }
      setAttemptId(data.attemptId);
      setQuestions(data.questions);
      setSelections({});
      setNumericInputs({});
      setCurrentIndex(0);
      setPhase("quiz");
    } catch {
      setError("Failed to load quiz.");
      setPhase("error");
    }
  }, [classId, quizId]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startQuiz();
  }, [startQuiz]);

  function selectOption(questionId: string, optionId: string) {
    setSelections((prev) => ({ ...prev, [questionId]: [optionId] }));
  }

  function toggleOption(questionId: string, optionId: string) {
    setSelections((prev) => {
      const current = prev[questionId] ?? [];
      const next = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
      if (next.length === 0) {
        const rest = { ...prev };
        delete rest[questionId];
        return rest;
      }
      return { ...prev, [questionId]: next };
    });
  }

  function setNumericInput(questionId: string, raw: string) {
    setNumericInputs((prev) => ({ ...prev, [questionId]: raw }));
  }

  // Single source of truth for "has this question been answered?" used by the
  // submit gate, the progress counter, and the question-dot styling. NUMERIC is
  // answered iff the raw input parses to a finite number; choice questions are
  // answered iff at least one option is selected.
  function isAnswered(q: Question): boolean {
    if (q.answerMode === "NUMERIC") {
      return normalizeNumericValue(numericInputs[q.id]) !== null;
    }
    return (selections[q.id]?.length ?? 0) > 0;
  }

  async function submitQuiz() {
    setSubmitting(true);
    try {
      const answers = questions.map((q) => ({
        questionId: q.id,
        selectedOptionId: selections[q.id]?.[0] || null,
        selectedOptionIds: selections[q.id] ?? [],
        numericValue: q.answerMode === "NUMERIC" ? normalizeNumericValue(numericInputs[q.id]) : null,
      }));
      const res = await fetch("/api/quiz", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId, answers }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setPhase("error"); return; }
      setResult(data);
      setPhase("results");
    } catch {
      setError("Failed to submit quiz.");
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  }

  const currentQuestion = questions[currentIndex];
  const allAnswered = questions.length > 0 && questions.every((q) => isAnswered(q));

  if (phase === "loading") {
    return (
      <div className="p-4 md:p-6 flex items-center justify-center min-h-64">
        <div className="animate-spin rounded-full size-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="p-4 md:p-6 max-w-xl space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/student/classes/${classId}`}><ArrowLeft className="size-4" /> Back to class</Link>
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center py-10 text-center">
            <XCircle className="size-12 text-destructive mb-3" />
            <p className="font-semibold mb-1">Could not load quiz</p>
            <p className="text-sm text-muted-foreground mb-4">{error}</p>
            <Button onClick={() => startQuiz()}>Try again</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "results" && result) {
    // Build the durable snapshot shape from the submit response so the inline
    // view uses the exact same component (and layout) as the history results
    // page. AI sections start PENDING and the view polls until the worker fills
    // them in — generation continues server-side even if the student leaves.
    // The post-submission PATCH payload now reveals the NUMERIC grading scalars
    // (answerNumeric/answerTolerance/answerUnit) and the presigned figureUrl, so
    // the inline snapshot can populate correctNumeric/tolerance/unit just like
    // the durable server-built one. figureStorageKey is passed as null here (the
    // client never sees raw keys); the transient figureUrl is re-attached below.
    const snapshot = buildReviewSnapshot(
      result.questions.map((q) => ({
        id: q.id,
        text: q.text,
        options: q.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect ?? false })),
        answerMode: q.answerMode,
        answerNumeric: q.answerNumeric ?? null,
        answerTolerance: q.answerTolerance ?? null,
        answerUnit: q.answerUnit ?? null,
        figureStorageKey: null,
        figureAlt: q.figureAlt ?? null,
      })),
      result.answers.map((a) => ({
        questionId: a.questionId,
        selectedOptionIds: a.selectedOptionIds ?? (a.selectedOptionId ? [a.selectedOptionId] : []),
        isCorrect: a.isCorrect,
        numericValue: a.numericValue ?? null,
      }))
    );

    // Re-attach the transient presigned figureUrl onto the built snapshot
    // questions (buildReviewSnapshot never sets it). The snapshot preserves the
    // input question order, so map positionally to the PATCH question rows.
    const snapshotQuestions = snapshot.questions.map((q, i) => ({
      ...q,
      figureUrl: result.questions[i]?.figureUrl ?? null,
    }));

    return (
      <ExamResultsView
        attemptId={attemptId}
        score={result.score}
        correct={result.correct}
        total={result.total}
        questions={snapshotQuestions}
        initial={{
          summary: null,
          summaryStatus: RESULT_STATUS.PENDING,
          recommendations: [],
          recommendationsStatus: RESULT_STATUS.PENDING,
          truncated: false,
        }}
        backHref={`/student/classes/${classId}`}
        backLabel="Back to class"
        actions={
          <>
            <Button onClick={() => startQuiz()} variant="outline">
              <RotateCcw className="size-4" /> Retry Quiz
            </Button>
            <Button asChild>
              <Link href={`/student/classes/${classId}`}>Back to Class</Link>
            </Button>
          </>
        }
      />
    );
  }

  // Quiz phase
  return (
    <div className="p-4 md:p-6 max-w-2xl space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/student/classes/${classId}`}><ArrowLeft className="size-4" /> Back to class</Link>
      </Button>

      {/* Progress */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Question {currentIndex + 1} of {questions.length}
        </p>
        <p className="text-sm text-muted-foreground">
          {questions.filter((q) => isAnswered(q)).length} answered
        </p>
      </div>
      <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${((currentIndex + 1) / questions.length) * 100}%` }}
        />
      </div>

      {/* Current Question */}
      {currentQuestion && (
        <Card>
          <CardHeader>
            {currentQuestion.figureUrl && (
              // Presigned S3 URLs don't fit next/image (no static dimensions /
              // remote-pattern config), so use a plain img by design.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={currentQuestion.figureUrl}
                alt={currentQuestion.figureAlt ?? "Question figure"}
                className="max-h-64 rounded-md border mb-3"
              />
            )}
            <CardTitle className="text-lg leading-relaxed">
              <MathText text={currentQuestion.text} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {currentQuestion.answerMode === "NUMERIC" ? (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    inputMode="decimal"
                    value={numericInputs[currentQuestion.id] ?? ""}
                    onChange={(e) => setNumericInput(currentQuestion.id, e.target.value)}
                    placeholder="Your answer"
                    className="max-w-xs"
                    aria-label="Numeric answer"
                  />
                  {currentQuestion.answerUnit && (
                    <span className="text-sm text-muted-foreground">
                      <MathText text={currentQuestion.answerUnit} />
                    </span>
                  )}
                </div>
                {(() => {
                  const raw = numericInputs[currentQuestion.id] ?? "";
                  const invalid = raw.trim() !== "" && normalizeNumericValue(raw) === null;
                  return invalid ? (
                    <p className="text-xs text-muted-foreground">Enter a number.</p>
                  ) : null;
                })()}
              </div>
            ) : (
              <>
                {currentQuestion.answerMode === "MULTI_SELECT" && (
                  <p className="text-xs text-muted-foreground">Select all that apply.</p>
                )}
                {currentQuestion.options.map((opt) => {
                  const selectedIds = selections[currentQuestion.id] ?? [];
                  const isSelected = selectedIds.includes(opt.id);
                  return (
                    <button type="button"
                      key={opt.id}
                      onClick={() => currentQuestion.answerMode === "MULTI_SELECT" ? toggleOption(currentQuestion.id, opt.id) : selectOption(currentQuestion.id, opt.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-all text-sm ${
                        isSelected
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      }`}
                    >
                      <span className="flex items-start gap-2">
                        <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${currentQuestion.answerMode === "MULTI_SELECT" ? "rounded" : "rounded-full"} ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground"}`}>
                          {isSelected ? "✓" : ""}
                        </span>
                        <MathText text={opt.text} />
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="space-y-3">
        {/* Question dot navigation — scrollable on narrow screens */}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {questions.map((q, i) => (
            <button type="button"
              key={q.id}
              onClick={() => setCurrentIndex(i)}
              className={`size-8 rounded-full text-xs font-medium transition-colors shrink-0 ${
                i === currentIndex
                  ? "bg-primary text-primary-foreground"
                  : isAnswered(q)
                  ? "bg-green-100 text-green-700"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>

        {/* Prev / Next buttons */}
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))} disabled={currentIndex === 0}>
            Previous
          </Button>
          {currentIndex < questions.length - 1 ? (
            <Button onClick={() => setCurrentIndex((i) => i + 1)}>Next</Button>
          ) : (
            <Button onClick={submitQuiz} disabled={!allAnswered || submitting}>
              {submitting ? "Submitting..." : "Submit Quiz"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
