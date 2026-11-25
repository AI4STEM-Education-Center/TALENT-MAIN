import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { MathText } from "@/components/ui/math-text";
import { cn } from "@/lib/utils";
import type {
  CoachQuestionOptionView,
  CoachQuestionView,
} from "@/lib/assistant/coach-types";

type Tone = "right" | "wrong" | "chosen" | "neutral";

const PILL_CLASS: Record<Exclude<Tone, "neutral">, string> = {
  right: "bg-green-600/10 text-green-700 dark:text-green-400",
  wrong: "bg-destructive/10 text-destructive",
  chosen: "bg-primary/10 text-primary",
};

function Pill({
  tone,
  children,
}: {
  tone: Exclude<Tone, "neutral">;
  children: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        PILL_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

/** One answer choice with its letter badge, as the student saw it. */
function OptionRow({
  label,
  text,
  imageUrl,
  imageAlt,
  tone,
  note,
}: {
  label: string;
  text: string;
  imageUrl: string | null;
  imageAlt: string | null;
  tone: Tone;
  note?: string;
}) {
  return (
    <li
      className={cn(
        "relative flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-sm",
        tone === "right" && "border-green-600/40 bg-green-600/5",
        tone === "wrong" && "border-destructive/40 bg-destructive/5",
        tone === "chosen" && "border-primary/50 bg-primary/5",
        tone === "neutral" && "border-border bg-background",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-bold",
          tone === "right" && "border-green-600 bg-green-600 text-white",
          tone === "wrong" &&
            "border-destructive bg-destructive text-destructive-foreground",
          tone === "chosen" &&
            "border-primary bg-primary text-primary-foreground",
          tone === "neutral" && "border-border bg-muted text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className="sr-only">Option {label}: </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        {imageUrl && (
          // Short-lived presigned S3 URL, which next/image cannot serve without
          // remote-pattern configuration.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={imageAlt ?? `Answer choice ${label}`}
            loading="lazy"
            className="max-h-24 w-fit rounded border bg-white"
          />
        )}
        {text && <MathText text={text} />}
      </span>
      {note && tone !== "neutral" && <Pill tone={tone}>{note}</Pill>}
    </li>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

function NumericRow({ text, tone }: { text: string; tone: "right" | "wrong" }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-2 text-sm",
        tone === "right"
          ? "border-green-600/40 bg-green-600/5 text-green-700 dark:text-green-400"
          : "border-destructive/40 bg-destructive/5 text-destructive",
      )}
    >
      <MathText text={text} />
    </div>
  );
}

/**
 * The tone and pill for one option. Before the attempt is final (`review`
 * null) only the student's own choice is marked — nothing here may hint at
 * which option is correct, because the server withheld the key on purpose.
 */
function optionTone(
  option: CoachQuestionOptionView,
  correct: boolean | null,
): { tone: Tone; note?: string } {
  if (correct === null)
    return option.selected
      ? { tone: "chosen", note: "Your answer" }
      : { tone: "neutral" };
  if (correct)
    return {
      tone: "right",
      note: option.selected ? "Your answer · correct" : "Correct",
    };
  return option.selected
    ? { tone: "wrong", note: "Your answer" }
    : { tone: "neutral" };
}

/**
 * The original question, kept on screen beside the chat: the prompt, its
 * figure, EVERY original option with letter badges and the student's own
 * choice. Only once the server says the attempt is final (`review` present)
 * does it add the answer key and the teacher's explanation. It never decides
 * that itself: `review` is either in the payload or it is not.
 */
export function CoachQuestionPane({
  question,
}: {
  question: CoachQuestionView;
}) {
  const { response, review, options } = question;
  const isChoice = options.length > 0;
  const nothingSelected = isChoice && options.every((o) => !o.selected);
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

      {isChoice && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>
              {question.answerMode === "MULTI_SELECT"
                ? "Options (select all that apply)"
                : "Options"}
            </SectionLabel>
            {nothingSelected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                <CircleDashed className="size-3" aria-hidden /> No answer
                selected
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {options.map((option, index) => {
              const correct = review
                ? (review.choices[index]?.correct ?? false)
                : null;
              const { tone, note } = optionTone(option, correct);
              return (
                <OptionRow
                  key={option.label}
                  label={option.label}
                  text={option.text}
                  imageUrl={option.imageUrl}
                  imageAlt={option.imageAlt}
                  tone={tone}
                  note={note}
                />
              );
            })}
          </ul>
        </div>
      )}

      {response.kind === "numeric" && (
        <div className="space-y-1.5">
          <SectionLabel>Your answer</SectionLabel>
          <NumericRow
            tone="wrong"
            text={
              response.value === null
                ? "No answer"
                : response.unit
                  ? `${response.value} ${response.unit}`
                  : String(response.value)
            }
          />
        </div>
      )}

      {review &&
        response.kind === "numeric" &&
        review.correctNumeric !== null && (
          <div className="space-y-1.5">
            <SectionLabel>Correct answer</SectionLabel>
            <NumericRow
              tone="right"
              text={
                review.unit
                  ? `${review.correctNumeric} ${review.unit}`
                  : String(review.correctNumeric)
              }
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
