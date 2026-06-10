import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Trophy, Loader2 } from "lucide-react";
import { RecommendationCard } from "@/components/student/RecommendationCard";
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

function QuestionCard({ question, index }: { question: SnapshotQuestion; index: number }) {
  return (
    <Card className={`h-full ${question.isCorrect ? "border-green-200" : "border-red-200"}`}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          {question.isCorrect ? (
            <CheckCircle className="size-4 text-green-500 mt-0.5 shrink-0" />
          ) : (
            <XCircle className="size-4 text-red-500 mt-0.5 shrink-0" />
          )}
          <p className="font-medium text-sm">
            {index + 1}. {question.text}
          </p>
        </div>
        <div className="space-y-1 ml-6">
          {question.options.map((opt, j) => (
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
              {opt.text}
            </div>
          ))}
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
