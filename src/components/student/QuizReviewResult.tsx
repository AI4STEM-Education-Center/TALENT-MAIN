import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Trophy, Loader2 } from "lucide-react";
import { RecommendationCard } from "@/components/student/RecommendationCard";
import { MathText } from "@/components/ui/math-text";
import {
  RESULT_STATUS,
  type ResultStatus,
  type SnapshotQuestion,
  type PresignedRecommendation,
} from "@/lib/exam-results";

const PASS_THRESHOLD = 60;

/**
 * Compact horizontal score banner. Has no border of its own — it sits at the
 * top of the unified results card, above the AI summary.
 */
export function ScoreBanner({
  score,
  correct,
  total,
}: {
  score: number;
  correct: number;
  total: number;
}) {
  const pct = Math.round(score);
  const passed = pct >= PASS_THRESHOLD;

  return (
    <div className="flex items-center gap-4">
      <Trophy className={`size-10 shrink-0 ${passed ? "text-yellow-500" : "text-muted-foreground"}`} />
      <div className="flex flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-bold leading-none">{pct}%</span>
        <span className="text-sm text-muted-foreground">
          {correct} / {total} correct
        </span>
      </div>
      <Badge variant={passed ? "success" : "destructive"} className="shrink-0 px-3 py-1 text-sm">
        {passed ? "Passed!" : "Keep practicing"}
      </Badge>
    </div>
  );
}

/**
 * Two rows for a NUMERIC question, styled to match the choice option rows:
 * the student's submitted value (green when correct, red otherwise) and the
 * correct value (always the correct-answer styling). Values + units render
 * through MathText (units may contain LaTeX). Uses nullish checks so a literal
 * 0 (value or tolerance) is preserved.
 */
function NumericRows({ question }: { question: SnapshotQuestion }) {
  const unit = question.unit ?? null;
  const withUnit = (value: string) => (unit ? `${value} ${unit}` : value);

  const submitted =
    question.submittedNumeric != null ? withUnit(String(question.submittedNumeric)) : null;

  const correctValue =
    question.correctNumeric != null ? String(question.correctNumeric) : null;
  const correctText =
    correctValue != null
      ? withUnit(
          question.tolerance != null
            ? `${correctValue} ± ${question.tolerance}`
            : correctValue
        )
      : null;

  return (
    <>
      <div
        className={`text-sm px-2 py-1 rounded flex items-center gap-2 ${
          question.isCorrect ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
        }`}
      >
        <span className="shrink-0">{question.isCorrect ? "✓" : "✗"}</span>
        <span>
          Your answer:{" "}
          {submitted != null ? <MathText text={submitted} /> : "No answer"}
        </span>
      </div>
      <div className="text-sm px-2 py-1 rounded flex items-center gap-2 bg-green-50 text-green-700">
        <span className="shrink-0">✓</span>
        <span>
          Correct answer: {correctText != null ? <MathText text={correctText} /> : "—"}
        </span>
      </div>
    </>
  );
}

function QuestionCard({ question, index }: { question: SnapshotQuestion; index: number }) {
  const isNumeric = question.answerMode === "NUMERIC";

  return (
    <Card className={`h-full ${question.isCorrect ? "border-green-200" : "border-red-200"}`}>
      <CardContent className="p-4 space-y-2">
        {question.figureUrl && (
          // Plain <img>: the src is a short-lived presigned S3 URL, which
          // next/image can't optimize (it would need remote-pattern config and
          // the URL expires). Mirrors RecommendationCard's presigned-image img.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={question.figureUrl}
            alt={question.figureAlt ?? "Question figure"}
            loading="lazy"
            className="max-h-64 rounded-md border mb-3"
          />
        )}
        <div className="flex items-start gap-2">
          {question.isCorrect ? (
            <CheckCircle className="size-4 text-green-500 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="size-4 text-red-500 mt-0.5 shrink-0" />
          )}
          <p className="font-medium text-sm">
            {index + 1}. <MathText text={question.text} />
          </p>
        </div>
        <div className="space-y-1 ml-6">
          {isNumeric ? (
            <NumericRows question={question} />
          ) : (
            question.options.map((opt, j) => (
              <div
                key={j}
                className={`text-sm px-2 py-1 rounded flex items-center gap-2 ${
                  opt.isCorrect
                    ? "bg-green-50 text-green-700"
                    : opt.selected && !opt.isCorrect
                    ? "bg-red-50 text-red-700"
                    : "text-muted-foreground"
                }`}
              >
                <span className="shrink-0">
                  {opt.isCorrect ? "✓" : opt.selected ? "✗" : " "}
                </span>
                {opt.imageUrl ? (
                  <span className="flex flex-wrap items-center gap-2">
                    {/* Plain <img>: short-lived presigned S3 URL (see figure img above). */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={opt.imageUrl}
                      alt={opt.imageAlt ?? "Answer choice"}
                      loading="lazy"
                      className="max-h-28 rounded border bg-white"
                    />
                    {opt.text && <MathText text={opt.text} />}
                  </span>
                ) : (
                  <MathText text={opt.text} />
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** The cell beside an incorrect question: its recommendation, a loader, or a note. */
function RecommendationCell({
  rec,
  status,
}: {
  rec?: PresignedRecommendation;
  status: ResultStatus;
}) {
  if (rec) return <RecommendationCard rec={rec} />;

  if (status === RESULT_STATUS.PENDING || status === RESULT_STATUS.GENERATING) {
    return (
      <div className="flex h-full items-center gap-2 rounded-xl border p-4 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" />
        Finding study material…
      </div>
    );
  }

  return (
    <div className="flex h-full items-center rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
      No specific material recommendation for this question.
    </div>
  );
}

/**
 * Per-question review. Each row is self-contained, so a tall recommendation
 * never leaves a gap before the next question. An incorrect question and its
 * recommendation share the same row height (the grid stretches both cells);
 * correct questions keep the left (question) column with the right side empty.
 */
export function QuizReviewList({
  questions,
  recommendations,
  recommendationsStatus,
  truncated,
}: {
  questions: SnapshotQuestion[];
  recommendations: PresignedRecommendation[];
  recommendationsStatus: ResultStatus;
  truncated: boolean;
}) {
  const recByQuestion = new Map(recommendations.map((r) => [r.questionText, r]));

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Review</h2>
      {questions.map((q, i) => (
        <div key={q.text} className="grid gap-3 xl:grid-cols-2">
          <QuestionCard question={q} index={i} />
          {!q.isCorrect && (
            <RecommendationCell rec={recByQuestion.get(q.text)} status={recommendationsStatus} />
          )}
        </div>
      ))}
      {truncated && (
        <p className="text-xs text-muted-foreground">
          You missed more questions than we could build recommendations for — start with the ones shown.
        </p>
      )}
    </div>
  );
}
