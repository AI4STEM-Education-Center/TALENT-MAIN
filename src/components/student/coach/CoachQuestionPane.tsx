import { CheckCircle2, XCircle } from "lucide-react";
import { MathText } from "@/components/ui/math-text";
import { cn } from "@/lib/utils";
import type { CoachQuestionView } from "@/lib/assistant/coach-types";

function Choice({
  text,
  imageUrl,
  imageAlt,
  tone,
  note,
}: {
  text: string;
  imageUrl: string | null;
  imageAlt: string | null;
  tone: "wrong" | "right" | "neutral";
  note?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1 text-sm",
        tone === "wrong" && "bg-destructive/10 text-destructive",
        tone === "right" && "bg-green-50 text-green-700",
        tone === "neutral" && "bg-muted/50",
      )}
    >
      {imageUrl && (
        // Short-lived presigned S3 URL, which next/image cannot serve without
        // remote-pattern configuration.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={imageAlt ?? "Answer choice"}
          loading="lazy"
          className="max-h-24 rounded border bg-white"
        />
      )}
      {text && <MathText text={text} />}
      {note && (
        <span className="ml-auto shrink-0 text-xs font-medium">{note}</span>
      )}
    </div>
  );
}

/**
 * The original question, kept on screen beside the chat. Shows what the
 * results page shows — the prompt, its figure and the student's own response —
 * and, only once the server says the attempt is final, the answer key and the
 * teacher's explanation. It never decides that itself: `review` is either
 * present in the payload or it is not.
 */
export function CoachQuestionPane({
  question,
}: {
  question: CoachQuestionView;
}) {
  const { response, review } = question;
  return (
    <section
      aria-label={`Question ${question.questionNumber}`}
      className="space-y-3"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {question.quizName} · Question {question.questionNumber}
      </p>

      {question.figureUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={question.figureUrl}
          alt={question.figureAlt ?? "Question figure"}
          loading="lazy"
          className="max-h-56 rounded-md border"
        />
      )}

      <p className="flex items-start gap-2 text-sm font-medium">
        <XCircle
          className="mt-0.5 size-4 shrink-0 text-destructive"
          aria-hidden
        />
        <span>
          <MathText text={question.text} />
        </span>
      </p>

      {review && question.response.kind === "choices" ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Options
          </p>
          {review.choices.map((choice) => (
            <Choice
              // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only list that is never reordered; text alone can repeat
              key={`${choice.text}-${choice.imageAlt ?? ""}-${choice.correct}-${choice.selected}`}
              text={choice.text}
              imageUrl={choice.imageUrl}
              imageAlt={choice.imageAlt}
              tone={
                choice.correct ? "right" : choice.selected ? "wrong" : "neutral"
              }
              note={
                choice.correct && choice.selected
                  ? "Your answer · correct"
                  : choice.correct
                    ? "Correct"
                    : choice.selected
                      ? "Your answer"
                      : undefined
              }
            />
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Your answer
          </p>
          {response.kind === "numeric" ? (
            <Choice
              text={
                response.value === null
                  ? "No answer"
                  : response.unit
                    ? `${response.value} ${response.unit}`
                    : String(response.value)
              }
              imageUrl={null}
              imageAlt={null}
              tone="wrong"
            />
          ) : response.choices.length === 0 ? (
            <Choice
              text="No answer"
              imageUrl={null}
              imageAlt={null}
              tone="wrong"
            />
          ) : (
            response.choices.map((choice, index) => (
              <Choice
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only, never reordered
                key={`${choice.text}-${choice.imageAlt ?? ""}-${index}`}
                text={choice.text}
                imageUrl={choice.imageUrl}
                imageAlt={choice.imageAlt}
                tone="wrong"
              />
            ))
          )}
        </div>
      )}

      {review &&
        response.kind === "numeric" &&
        review.correctNumeric !== null && (
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Correct answer
            </p>
            <Choice
              text={
                review.unit
                  ? `${review.correctNumeric} ${review.unit}`
                  : String(review.correctNumeric)
              }
              imageUrl={null}
              imageAlt={null}
              tone="right"
            />
          </div>
        )}

      {review?.explanation && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-sm">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <CheckCircle2 className="size-3.5" aria-hidden /> Teacher&apos;s
            explanation
          </p>
          <MathText text={review.explanation} />
        </div>
      )}
    </section>
  );
}
