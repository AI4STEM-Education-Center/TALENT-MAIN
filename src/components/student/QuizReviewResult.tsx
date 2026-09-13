import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScoreDial } from "@/components/viz/ScoreDial";
import { CheckCircle, XCircle, Trophy } from "lucide-react";
import { MathText } from "@/components/ui/math-text";
import {
  type SnapshotQuestion,
  type StoredQuestionMisconceptions,
} from "@/lib/exam-results";

const PASS_THRESHOLD = 60;
const EMPTY_QUESTION_MISCONCEPTIONS: StoredQuestionMisconceptions[] = [];

/**
 * The score, as the hero figure of the results page. Has no border of its own —
 * it sits at the top of the unified results card, above the AI summary. The
 * "X / N correct" count is shown only when `correct`/`total` are provided (the
 * teacher attempt detail view); the blind student view passes the percentage
 * alone, and the dial's caption is simply omitted.
 */
export function ScoreBanner({
  score,
  correct,
  total,
}: {
  score: number;
  correct?: number;
  total?: number;
}) {
  const pct = Math.round(score);
  const passed = pct >= PASS_THRESHOLD;
  const showCount = correct != null && total != null;

  return (
    // The score is what this page is about, so it gets the hero treatment: one
    // radial meter, one number, and the words that say how it went. The dial is
    // pure CSS — no JS runs to animate it, and reduced-motion lands it flat.
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <ScoreDial
        score={pct}
        label="Score"
        caption={showCount ? `${correct} of ${total} correct` : undefined}
      />
      <div className="flex flex-col items-center gap-2 sm:items-start">
        <Trophy
          className={`size-8 ${passed ? "text-[var(--viz-warning)]" : "text-muted-foreground"}`}
          aria-hidden="true"
        />
        <Badge
          variant={passed ? "success" : "destructive"}
          className="px-3 py-1 text-sm"
        >
          {passed ? "Passed!" : "Keep practicing"}
        </Badge>
        <p className="text-sm text-muted-foreground">
          {passed
            ? "You cleared the pass mark for this quiz."
            : `${PASS_THRESHOLD}% is the pass mark — the review below shows where the marks went.`}
        </p>
      </div>
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
    question.submittedNumeric != null
      ? withUnit(String(question.submittedNumeric))
      : null;

  const correctValue =
    question.correctNumeric != null ? String(question.correctNumeric) : null;
  const correctText =
    correctValue != null
      ? withUnit(
          question.tolerance != null
            ? `${correctValue} ± ${question.tolerance}`
            : correctValue,
        )
      : null;

  return (
    <>
      <div
        className={`text-sm px-2 py-1 rounded flex items-center gap-2 ${
          question.isCorrect
            ? "bg-green-50 text-green-700"
            : "bg-red-50 text-red-700"
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
          Correct answer:{" "}
          {correctText != null ? <MathText text={correctText} /> : "—"}
        </span>
      </div>
    </>
  );
}

function QuestionCard({
  question,
  index,
  misconceptionTags,
}: {
  question: SnapshotQuestion;
  index: number;
  misconceptionTags?: StoredQuestionMisconceptions;
}) {
  const isNumeric = question.answerMode === "NUMERIC";

  return (
    <Card
      className={`h-full ${question.isCorrect ? "border-green-200" : "border-red-200"}`}
    >
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
        {!question.isCorrect && misconceptionTags && (
          <div className="ml-6 border-t pt-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Teacher-only misconception tags
            </p>
            <div className="flex flex-wrap gap-2">
              {misconceptionTags.misconceptions.map((misconception) => (
                <Badge
                  key={misconception.misconceptionId}
                  variant="outline"
                  className="h-auto whitespace-normal py-1"
                >
                  <span className="font-mono mr-1">
                    {misconception.misconceptionId}
                  </span>
                  {misconception.statement}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Full per-question review with correct answers revealed. This surface is
 * TEACHER-ONLY (the teacher attempt-detail page); students never see it — their
 * blind results show only the score, the AI summary, and holistic study
 * recommendations.
 */
export function QuizReviewList({
  questions,
  errorMisconceptions = EMPTY_QUESTION_MISCONCEPTIONS,
}: {
  questions: SnapshotQuestion[];
  errorMisconceptions?: StoredQuestionMisconceptions[];
}) {
  const misconceptionByQuestionIndex = new Map(
    errorMisconceptions.map((entry) => [entry.questionIndex, entry]),
  );
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Review</h2>
      <div className="grid gap-3 xl:grid-cols-2">
        {questions.map((q, i) => (
          <QuestionCard
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- key falls back to a content-composite string and this review list is read-only and never reordered
            key={q.questionId ?? `${q.text}-${i}`}
            question={q}
            index={i}
            misconceptionTags={misconceptionByQuestionIndex.get(i)}
          />
        ))}
      </div>
    </div>
  );
}
