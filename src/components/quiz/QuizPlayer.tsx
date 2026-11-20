"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, XCircle, RotateCcw, Maximize2 } from "lucide-react";
import { ExamResultsView } from "@/components/student/ExamResultsView";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MathText } from "@/components/ui/math-text";
import { RESULT_STATUS, type StudentMistakeView } from "@/lib/exam-results";
import { normalizeNumericValue } from "@/lib/quiz-scoring";
import {
  alternativeNotice,
  officialExcludedNotice,
  type QuizQuestionExclusionOptions,
} from "@/lib/alternative-retake";

import {
  startPracticeQuiz,
  startQuizPreview,
  startStudentQuiz,
  type QuizQuestion,
  type QuizResult,
  type QuizSession,
} from "./quiz-session";
import { ScoreBanner } from "@/components/student/QuizReviewResult";
import { StudentMistakesReview } from "@/components/student/StudentMistakesReview";

/** Options shared by the two real (recorded) student modes. */
type StudentLaunch = {
  classId: string;
  /** Questions to leave out of a NEW attempt (ignored when resuming). */
  exclusionOptions?: QuizQuestionExclusionOptions;
  /**
   * Return to the quiz setup screen, optionally with a mode preselected.
   * When set, "Retake quiz" / "Practice another version" go there so the
   * student can choose again, instead of starting straight away.
   */
  onBackToSetup?: (mode?: "official" | "practice") => void;
};

type QuizPlayerProps = {
  quizId: string;
  backHref: string;
  backLabel: string;
} & (
  | { mode: "preview"; classId?: never }
  | ({ mode: "student" } & StudentLaunch)
  | ({
      mode: "practice";
      /** Shortcut for `exclusionOptions: { excludeCorrect: true }`. */
      excludeCorrect?: boolean;
      /** Return to the practice options to choose another version. */
      onPracticeAgain?: () => void;
    } & StudentLaunch)
);

const NO_EXCLUSIONS: QuizQuestionExclusionOptions = {};

/** The calm note during a quiz that some questions were left out. */
function ExclusionNote({ session }: { session: QuizSession | null }) {
  const count = session?.excludedCount ?? 0;
  if (!count && !session?.exclusionIgnored) return null;
  return (
    <>
      {!!count &&
        ` ${count} question${count === 1 ? "" : "s"} you answered correctly before ${count === 1 ? "is" : "are"} left out.`}
      {session?.exclusionIgnored &&
        " You answered everything correctly before, so the full set is shown."}
    </>
  );
}

type Phase = "loading" | "quiz" | "results" | "error";

/** An in-progress attempt's unsent answers, kept across "Quiz options". */
type QuizDraft = {
  selections: Record<string, string[]>;
  numericInputs: Record<string, string>;
  currentIndex: number;
};

/** Drafts are per attempt; previews have no attempt to resume. */
function draftKeyFor(session: QuizSession | null): string | null {
  const id = session?.attemptId;
  return id && id !== "preview" ? `quiz-draft:${id}` : null;
}

/**
 * The saved draft for this attempt, limited to questions still in it. Storage
 * can be unavailable or hold anything, so every field is checked.
 */
function readDraft(key: string, questions: QuizQuestion[]): QuizDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const draft = raw as Partial<Record<keyof QuizDraft, unknown>>;
  const ids = new Set(questions.map((q) => q.id));
  const selections: Record<string, string[]> = {};
  if (draft.selections && typeof draft.selections === "object")
    for (const [id, value] of Object.entries(draft.selections))
      if (
        ids.has(id) &&
        Array.isArray(value) &&
        value.every((v) => typeof v === "string")
      )
        selections[id] = value;
  const numericInputs: Record<string, string> = {};
  if (draft.numericInputs && typeof draft.numericInputs === "object")
    for (const [id, value] of Object.entries(draft.numericInputs))
      if (ids.has(id) && typeof value === "string") numericInputs[id] = value;
  const index =
    typeof draft.currentIndex === "number" &&
    Number.isInteger(draft.currentIndex)
      ? Math.min(Math.max(draft.currentIndex, 0), questions.length - 1)
      : 0;
  return { selections, numericInputs, currentIndex: index };
}

function writeDraft(key: string, draft: QuizDraft) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the draft just won't survive leaving the quiz.
  }
}

function clearDraft(key: string | null) {
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

export function QuizPlayer(props: QuizPlayerProps) {
  const { quizId, mode, classId, backHref, backLabel } = props;
  // Serialized so a caller passing a fresh object each render does not change
  // what the start callback depends on.
  const exclusionKey = JSON.stringify(
    mode === "preview"
      ? NO_EXCLUSIONS
      : (props.exclusionOptions ??
          (mode === "practice" && props.excludeCorrect
            ? { excludeCorrect: true }
            : NO_EXCLUSIONS)),
  );
  const onBackToSetup = mode === "preview" ? undefined : props.onBackToSetup;
  const onPracticeAgain =
    mode === "practice"
      ? (props.onPracticeAgain ??
        (onBackToSetup ? () => onBackToSetup("practice") : undefined))
      : onBackToSetup
        ? () => onBackToSetup("practice")
        : undefined;
  const [phase, setPhase] = useState<Phase>("loading");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [session, setSession] = useState<QuizSession | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  // Raw, unparsed NUMERIC field strings keyed by question id. Kept raw (rather
  // than parsed numbers) so partial input like "-" or "3." types naturally;
  // normalizeNumericValue is applied wherever a real number is needed.
  const [numericInputs, setNumericInputs] = useState<Record<string, string>>(
    {},
  );
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Click-to-enlarge for question figures and image answer-choices.
  const [zoom, setZoom] = useState<{ url: string; alt: string } | null>(null);

  // Student starts reserve an attempt. Keep mount auto-start to one request,
  // including StrictMode's effect replay; button-driven retries start anew.
  const startedRef = useRef(false);

  const startQuiz = useCallback(async () => {
    setPhase("loading");
    const exclusionOptions = JSON.parse(
      exclusionKey,
    ) as QuizQuestionExclusionOptions;
    try {
      const data =
        mode === "preview"
          ? await startQuizPreview(quizId)
          : mode === "practice"
            ? await startPracticeQuiz(classId, quizId, exclusionOptions)
            : await startStudentQuiz(classId, quizId, exclusionOptions);
      if (data.questions.length === 0) {
        // Nothing to answer: say so instead of rendering "Question 1 of 0".
        setSession(null);
        setQuestions([]);
        setError(
          "This quiz has no questions available right now. Try again, or ask your teacher.",
        );
        setPhase("error");
        return;
      }
      // Resuming the same attempt (e.g. back from "Quiz options") restores the
      // answers given so far.
      const key = draftKeyFor(data);
      const draft = key ? readDraft(key, data.questions) : null;
      setSession(data);
      setQuestions(data.questions);
      setSelections(draft?.selections ?? {});
      setNumericInputs(draft?.numericInputs ?? {});
      setResult(null);
      setCurrentIndex(draft?.currentIndex ?? 0);
      setZoom(null);
      setError("");
      setPhase("quiz");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load quiz.");
      setPhase("error");
    }
  }, [mode, classId, quizId, exclusionKey]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startQuiz();
  }, [startQuiz]);

  // Keep the in-progress answers for this attempt as they change.
  const draftKey = draftKeyFor(session);
  useEffect(() => {
    if (phase !== "quiz" || !draftKey) return;
    writeDraft(draftKey, { selections, numericInputs, currentIndex });
  }, [phase, draftKey, selections, numericInputs, currentIndex]);

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
  function isAnswered(q: QuizQuestion): boolean {
    if (q.answerMode === "NUMERIC") {
      return normalizeNumericValue(numericInputs[q.id]) !== null;
    }
    return (selections[q.id]?.length ?? 0) > 0;
  }

  async function submitQuiz() {
    if (!session || submitting) return;
    setSubmitting(true);
    try {
      const answers = questions.map((q) => ({
        questionId: q.id,
        selectedOptionId: selections[q.id]?.[0] || null,
        selectedOptionIds: selections[q.id] ?? [],
        numericValue:
          q.answerMode === "NUMERIC"
            ? normalizeNumericValue(numericInputs[q.id])
            : null,
      }));
      const data = await session.submit(answers);
      clearDraft(draftKeyFor(session));
      setResult(data);
      setPhase("results");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Failed to submit quiz.",
      );
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  }

  const currentQuestion = questions[currentIndex];
  const allAnswered =
    questions.length > 0 && questions.every((q) => isAnswered(q));

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
          <Link href={backHref}>
            <ArrowLeft className="size-4" /> {backLabel}
          </Link>
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
    const incorrectIds = new Set(result.incorrectQuestionIds);
    const mistakes = questions.flatMap<StudentMistakeView>(
      (question, index) => {
        if (!incorrectIds.has(question.id)) return [];

        const base = {
          questionNumber: index + 1,
          text: question.text,
          figureUrl: question.figureUrl ?? null,
          figureAlt: question.figureAlt ?? null,
        };
        if (question.answerMode === "NUMERIC") {
          return [
            {
              ...base,
              response: {
                kind: "numeric" as const,
                value: normalizeNumericValue(numericInputs[question.id]),
                unit: question.answerUnit ?? null,
              },
            },
          ];
        }

        const selectedIds = new Set(selections[question.id] ?? []);
        return [
          {
            ...base,
            response: {
              kind: "choices" as const,
              choices: question.options.flatMap((option) =>
                selectedIds.has(option.id)
                  ? [
                      {
                        text: option.text,
                        imageUrl: option.imageUrl ?? null,
                        imageAlt: option.imageAlt ?? null,
                      },
                    ]
                  : [],
              ),
            },
          },
        ];
      },
    );

    if (mode === "preview") {
      return (
        <div className="p-4 md:p-6 max-w-2xl space-y-6">
          <h2 className="text-xl font-semibold">Preview results</h2>
          <ScoreBanner score={result.score} />
          <StudentMistakesReview mistakes={mistakes} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => startQuiz()} variant="outline">
              <RotateCcw className="size-4" /> Restart preview
            </Button>
            <Button asChild>
              <Link href={backHref}>{backLabel}</Link>
            </Button>
          </div>
        </div>
      );
    }

    // AI sections start PENDING and stream in independently. The missed-question
    // review is built only from prompts/responses already held by this client
    // plus the server's incorrect-id list, never from an answer key.
    return (
      <ExamResultsView
        attemptId={result.quizAttemptId ?? session!.attemptId!}
        score={result.score}
        mistakes={mistakes}
        initial={{
          summary: null,
          summaryStatus: RESULT_STATUS.PENDING,
          summaryMetrics: null,
          recommendations: [],
          simulations: [],
          recommendationsStatus: RESULT_STATUS.PENDING,
          recommendationMetrics: null,
          truncated: false,
        }}
        backHref={backHref}
        backLabel={backLabel}
        simulationSurface="quiz_results"
        notice={
          mode === "practice"
            ? alternativeNotice(
                session?.versionName ?? "Practice",
                session?.excludedCount ?? 0,
              )
            : officialExcludedNotice(session?.excludedCount ?? 0) || undefined
        }
        actions={
          <>
            {onPracticeAgain ? (
              <Button variant="outline" onClick={onPracticeAgain}>
                Practice another version
              </Button>
            ) : (
              <Button variant="outline" asChild>
                <Link
                  href={`/student/classes/${classId}/quiz/${quizId}/practice`}
                >
                  Practice another version
                </Link>
              </Button>
            )}
            {onBackToSetup ? (
              <Button
                variant="outline"
                onClick={() => onBackToSetup("official")}
              >
                <RotateCcw className="size-4" /> Retake quiz
              </Button>
            ) : mode === "practice" ? (
              <Button variant="outline" asChild>
                <Link href={`/student/classes/${classId}/quiz/${quizId}`}>
                  <RotateCcw className="size-4" /> Retake quiz
                </Link>
              </Button>
            ) : (
              <Button onClick={() => startQuiz()} variant="outline">
                <RotateCcw className="size-4" /> Retry Quiz
              </Button>
            )}
            <Button asChild>
              <Link href={backHref}>{backLabel}</Link>
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
        <Link href={backHref}>
          <ArrowLeft className="size-4" /> {backLabel}
        </Link>
      </Button>

      {mode === "practice" && (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {session?.versionName} · Alternative version
          </p>
          <p className="text-xs text-muted-foreground">
            Recorded as a retake. Your graded score and attempt allowance are
            unchanged.
            <ExclusionNote session={session} />
          </p>
        </div>
      )}
      {mode === "student" &&
        (!!session?.excludedCount || session?.exclusionIgnored) && (
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Official quiz.
            <ExclusionNote session={session} /> Your score covers the questions
            in this attempt.
          </p>
        )}

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
          className="h-full bg-primary transition-[width]"
          style={{ width: `${((currentIndex + 1) / questions.length) * 100}%` }}
        />
      </div>

      {/* Current Question */}
      {currentQuestion && (
        <Card>
          <CardHeader>
            {currentQuestion.figureUrl && (
              <button
                type="button"
                onClick={() =>
                  setZoom({
                    url: currentQuestion.figureUrl!,
                    alt: currentQuestion.figureAlt ?? "Question figure",
                  })
                }
                aria-label="Enlarge figure"
                className="group relative mb-3 block"
              >
                {/* Presigned S3 URLs don't fit next/image (no static dimensions /
                    remote-pattern config), so use a plain img by design. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={currentQuestion.figureUrl}
                  alt={currentQuestion.figureAlt ?? "Question figure"}
                  className="max-h-64 rounded-md border"
                />
                <span className="absolute right-1 top-1 rounded bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <Maximize2 className="size-4" />
                </span>
              </button>
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
                    onChange={(e) =>
                      setNumericInput(currentQuestion.id, e.target.value)
                    }
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
                  const invalid =
                    raw.trim() !== "" && normalizeNumericValue(raw) === null;
                  return invalid ? (
                    <p className="text-xs text-muted-foreground">
                      Enter a number.
                    </p>
                  ) : null;
                })()}
              </div>
            ) : (
              <>
                {currentQuestion.answerMode === "MULTI_SELECT" && (
                  <p className="text-xs text-muted-foreground">
                    Select all that apply.
                  </p>
                )}
                {currentQuestion.options.map((opt) => {
                  const selectedIds = selections[currentQuestion.id] ?? [];
                  const isSelected = selectedIds.includes(opt.id);
                  return (
                    <div key={opt.id} className="flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          currentQuestion.answerMode === "MULTI_SELECT"
                            ? toggleOption(currentQuestion.id, opt.id)
                            : selectOption(currentQuestion.id, opt.id)
                        }
                        aria-pressed={isSelected}
                        className={`grow text-left p-3 rounded-lg border transition-all text-sm ${
                          isSelected
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "border-border hover:border-primary/50 hover:bg-muted/50"
                        }`}
                      >
                        <span className="flex items-start gap-2">
                          <span
                            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center border ${currentQuestion.answerMode === "MULTI_SELECT" ? "rounded" : "rounded-full"} ${isSelected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground"}`}
                          >
                            {isSelected ? "✓" : ""}
                          </span>
                          {opt.imageUrl ? (
                            <span className="flex flex-col gap-1">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={opt.imageUrl}
                                alt={opt.imageAlt ?? "Answer choice"}
                                className="max-h-40 w-auto max-w-full rounded border bg-white"
                              />
                              {opt.text && <MathText text={opt.text} />}
                            </span>
                          ) : (
                            <MathText text={opt.text} />
                          )}
                        </span>
                      </button>
                      {opt.imageUrl && (
                        <button
                          type="button"
                          onClick={() =>
                            setZoom({
                              url: opt.imageUrl!,
                              alt: opt.imageAlt ?? "Answer choice",
                            })
                          }
                          aria-label="Enlarge choice image"
                          className="flex shrink-0 items-center rounded-lg border px-2 text-muted-foreground hover:bg-muted/50"
                        >
                          <Maximize2 className="size-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Click-to-enlarge lightbox for figures and image answer-choices. */}
      <Dialog open={!!zoom} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-normal text-muted-foreground">
              {zoom?.alt ?? "Image"}
            </DialogTitle>
          </DialogHeader>
          {zoom && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={zoom.url}
              alt={zoom.alt}
              className="mx-auto block max-h-[80vh] w-auto max-w-full"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Navigation */}
      <div className="space-y-3">
        {/* Question dot navigation — scrollable on narrow screens */}
        <div className="flex gap-1 overflow-x-auto pb-1">
          {questions.map((q, i) => (
            <button
              type="button"
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
          <Button
            variant="outline"
            onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
          >
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
