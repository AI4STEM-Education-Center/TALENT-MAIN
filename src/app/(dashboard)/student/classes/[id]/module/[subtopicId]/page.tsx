"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, CheckCircle, XCircle, RotateCcw, Trophy } from "lucide-react";

interface Option { id: string; text: string; isCorrect?: boolean }
interface Question { id: string; text: string; options: Option[] }
interface QuizResult {
  score: number;
  correct: number;
  total: number;
  questions: Question[];
  answers: { questionId: string; selectedOptionId: string | null; isCorrect: boolean }[];
}

type Phase = "loading" | "quiz" | "results" | "error";

export default function ModulePage() {
  const { id: classId, subtopicId } = useParams<{ id: string; subtopicId: string }>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [attemptId, setAttemptId] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState<Record<string, string>>({});
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
    setSelections((prev) => ({ ...prev, [questionId]: optionId }));
  }

  async function submitQuiz() {
    setSubmitting(true);
    try {
      const answers = questions.map((q) => ({
        questionId: q.id,
        selectedOptionId: selections[q.id] || null,
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
  const allAnswered = questions.length > 0 && questions.every((q) => selections[q.id]);

  if (phase === "loading") {
    return (
      <div className="p-6 flex items-center justify-center min-h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="p-6 max-w-xl space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/student/classes/${classId}`}><ArrowLeft className="w-4 h-4" /> Back to class</Link>
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center py-10 text-center">
            <XCircle className="w-12 h-12 text-destructive mb-3" />
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
      <div className="p-6 max-w-2xl space-y-6">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/student/classes/${classId}`}><ArrowLeft className="w-4 h-4" /> Back to class</Link>
        </Button>

        <Card>
          <CardContent className="flex flex-col items-center py-8 text-center">
            <Trophy className={`w-14 h-14 mb-3 ${passed ? "text-yellow-500" : "text-muted-foreground"}`} />
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
            const selected = answer?.selectedOptionId;
            const correct = answer?.isCorrect;

            return (
              <Card key={q.id} className={correct ? "border-green-200" : "border-red-200"}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start gap-2">
                    {correct ? <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" /> : <XCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />}
                    <p className="font-medium text-sm">{i + 1}. {q.text}</p>
                  </div>
                  <div className="space-y-1 ml-6">
                    {q.options.map((opt) => {
                      const isSelected = opt.id === selected;
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
            <RotateCcw className="w-4 h-4" /> Retry Quiz
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
    <div className="p-6 max-w-2xl space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/student/classes/${classId}`}><ArrowLeft className="w-4 h-4" /> Back to class</Link>
      </Button>

      {/* Progress */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Question {currentIndex + 1} of {questions.length}
        </p>
        <p className="text-sm text-muted-foreground">
          {Object.keys(selections).length} answered
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
            {currentQuestion.options.map((opt) => {
              const isSelected = selections[currentQuestion.id] === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => selectOption(currentQuestion.id, opt.id)}
                  className={`w-full text-left p-3 rounded-lg border transition-all text-sm ${
                    isSelected
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  {opt.text}
                </button>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))} disabled={currentIndex === 0}>
          Previous
        </Button>

        <div className="flex gap-1">
          {questions.map((q, i) => (
            <button
              key={q.id}
              onClick={() => setCurrentIndex(i)}
              className={`w-7 h-7 rounded-full text-xs font-medium transition-colors ${
                i === currentIndex
                  ? "bg-primary text-primary-foreground"
                  : selections[q.id]
                  ? "bg-green-100 text-green-700"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {i + 1}
            </button>
          ))}
        </div>

        {currentIndex < questions.length - 1 ? (
          <Button onClick={() => setCurrentIndex((i) => i + 1)}>Next</Button>
        ) : (
          <Button onClick={submitQuiz} disabled={!allAnswered || submitting}>
            {submitting ? "Submitting..." : "Submit Quiz"}
          </Button>
        )}
      </div>
    </div>
  );
}
