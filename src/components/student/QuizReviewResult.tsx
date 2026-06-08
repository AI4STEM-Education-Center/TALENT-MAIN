import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Trophy } from "lucide-react";
import type { SnapshotQuestion } from "@/lib/exam-results";

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

/** Per-question review rendered entirely from the durable snapshot. */
export function QuizReviewList({ questions }: { questions: SnapshotQuestion[] }) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Review</h2>
      {questions.map((q, i) => (
        <Card key={i} className={q.isCorrect ? "border-green-200" : "border-red-200"}>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-start gap-2">
              {q.isCorrect ? (
                <CheckCircle className="size-4 text-green-500 mt-0.5 flex-shrink-0" />
              ) : (
                <XCircle className="size-4 text-red-500 mt-0.5 flex-shrink-0" />
              )}
              <p className="font-medium text-sm">
                {i + 1}. {q.text}
              </p>
            </div>
            <div className="space-y-1 ml-6">
              {q.options.map((opt, j) => (
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
      ))}
    </div>
  );
}
