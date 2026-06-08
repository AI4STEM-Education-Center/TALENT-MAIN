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

/** Top score card: percentage, correct/total, pass/fail badge. */
export function ScoreSummaryCard({
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
    <Card>
      <CardContent className="flex flex-col items-center py-8 text-center">
        <Trophy className={`size-14 mb-3 ${passed ? "text-yellow-500" : "text-muted-foreground"}`} />
        <p className="text-4xl font-bold mb-1">{pct}%</p>
        <p className="text-muted-foreground">
          {correct} / {total} correct
        </p>
        <Badge variant={passed ? "success" : "destructive"} className="mt-3 text-sm px-3 py-1">
          {passed ? "Passed!" : "Keep practicing"}
        </Badge>
      </CardContent>
    </Card>
  );
}

function QuestionCard({ question, index }: { question: SnapshotQuestion; index: number }) {
  return (
    <Card className={question.isCorrect ? "border-green-200" : "border-red-200"}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          {question.isCorrect ? (
            <CheckCircle className="size-4 text-green-500 mt-0.5 flex-shrink-0" />
          ) : (
            <XCircle className="size-4 text-red-500 mt-0.5 flex-shrink-0" />
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
              <span className="flex-shrink-0">
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
      <div className="flex items-center gap-2 rounded-xl border p-4 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" />
        Finding study material…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
      No specific material recommendation for this question.
    </div>
  );
}

/**
 * Per-question review. Each incorrect question is paired side-by-side (on wide
 * screens) with a card holding its recommended materials; correct questions
 * span the full width. Matching is by question text.
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
      {questions.map((q, i) => {
        const card = <QuestionCard question={q} index={i} />;
        // Correct answers need no recommendation — show the question full width.
        if (q.isCorrect) return <div key={i}>{card}</div>;
        // Incorrect: pair the question with its recommendation. They sit side by
        // side once there's room (xl), and stack (question first) below that.
        return (
          <div key={i} className="grid gap-3 xl:grid-cols-2 xl:items-start">
            {card}
            <RecommendationCell rec={recByQuestion.get(q.text)} status={recommendationsStatus} />
          </div>
        );
      })}
      {truncated && (
        <p className="text-xs text-muted-foreground">
          You missed more questions than we could build recommendations for — start with the ones shown.
        </p>
      )}
    </div>
  );
}
