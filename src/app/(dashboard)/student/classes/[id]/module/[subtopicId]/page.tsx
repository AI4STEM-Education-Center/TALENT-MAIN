"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, XCircle, RotateCcw, Trophy } from "lucide-react";

interface Option { id: string; text: string; isCorrect?: boolean }
interface Question { id: string; text: string; answerMode: "SINGLE_SELECT" | "MULTI_SELECT"; options: Option[] }
interface QuizResult {
  score: number;
  correct: number;
  total: number;
  questions: Question[];
  answers: { questionId: string; selectedOptionId: string | null; selectedOptionIds?: string[]; isCorrect: boolean }[];
}

type Phase = "loading" | "quiz" | "results" | "error";

export default function ModulePage() {
  const { id: classId, subtopicId } = useParams<{ id: string; subtopicId: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [attemptId, setAttemptId] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    startQuiz();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startQuiz() {
    setPhase("loading");
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classId, subtopicId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); setPhase("error"); return; }
      setAttemptId(data.attemptId);
      setQuestions(data.questions);
      setSelections({});
      setCurrentIndex(0);
      setPhase("quiz");
    } catch {
      setError("Failed to load quiz.");
      setPhase("error");
    }
  }

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

  async function submitQuiz() {
    setSubmitting(true);
    try {
      const answers = questions.map((q) => ({
        questionId: q.id,
        selectedOptionId: selections[q.id]?.[0] || null,
        selectedOptionIds: selections[q.id] ?? [],
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
  const allAnswered = questions.length > 0 && questions.every((q) => (selections[q.id]?.length ?? 0) > 0);

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
    const pct = Math.round(result.score);
    const passed = pct >= 60;

    return (
      <div className="p-4 md:p-6 max-w-2xl space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/student/classes/${classId}`}><ArrowLeft className="size-4" /> Back to class</Link>
        </Button>

        <Card>
          <CardContent className="flex flex-col items-center py-8 text-center">
            <Trophy className={`size-14 mb-3 ${passed ? "text-yellow-500" : "text-muted-foreground"}`} />
            <p className="text-4xl font-bold mb-1">{pct}%</p>
            <p className="text-muted-foreground">{result.correct} / {result.total} correct</p>
            <Badge variant={passed ? "success" : "destructive"} className="mt-3 text-sm px-3 py-1">
              {passed ? "Passed!" : "Keep practicing"}
            </Badge>
          </CardContent>
        </Card>

        {/* Review */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Review</h2>
          {result.questions.map((q, i) => {
            const answer = result.answers.find((a) => a.questionId === q.id);
            const selectedIds = new Set(answer?.selectedOptionIds ?? (answer?.selectedOptionId ? [answer.selectedOptionId] : []));
            const correct = answer?.isCorrect;

            return (
              <Card key={q.id} className={correct ? "border-green-200" : "border-red-200"}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start gap-2">
                    {correct ? <CheckCircle className="size-4 text-green-500 mt-0.5 flex-shrink-0" /> : <XCircle className="size-4 text-red-500 mt-0.5 flex-shrink-0" />}
                    <p className="font-medium text-sm">{i + 1}. {q.text}</p>
                  </div>
                  <div className="space-y-1 ml-6">
                    {q.options.map((opt) => {
                      const isSelected = selectedIds.has(opt.id);
                      const isCorrect = opt.isCorrect;
                      return (
                        <div key={opt.id} className={`text-sm px-2 py-1 rounded flex items-center gap-2 ${isCorrect ? "bg-green-50 text-green-700" : isSelected && !isCorrect ? "bg-red-50 text-red-700" : "text-muted-foreground"}`}>
                          <span className="flex-shrink-0">{isCorrect ? "✓" : isSelected ? "✗" : " "}</span>
                          {opt.text}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="flex gap-3">
          <Button onClick={() => startQuiz()} variant="outline">
            <RotateCcw className="size-4" /> Retry Quiz
          </Button>
          <Button asChild>
            <Link href={`/student/classes/${classId}`}>Back to Class</Link>
          </Button>
        </div>
      </div>
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
          {questions.filter((q) => (selections[q.id]?.length ?? 0) > 0).length} answered
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
            <CardTitle className="text-lg leading-relaxed">{currentQuestion.text}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
                    <span>{opt.text}</span>
                  </span>
                </button>
              );
            })}
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
                  : (selections[q.id]?.length ?? 0) > 0
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
