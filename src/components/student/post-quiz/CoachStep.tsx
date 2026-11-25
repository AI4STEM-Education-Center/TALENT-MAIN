"use client";

import { useCallback, useMemo } from "react";
import { Check, MessageCircleQuestion, XCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MathText } from "@/components/ui/math-text";
import { useOptionalAssistant } from "@/components/assistant/assistant-context";
import { CoachWorkspace } from "@/components/student/coach/WrongAnswerCoach";
import { cn } from "@/lib/utils";
import type { StudentMistakeView } from "@/lib/exam-results";
import { AdvanceButton, StepHeader } from "./GuidedChrome";

/** Question 1 … N, with a tick on each one the student has worked through. */
function QuestionStrip({
  mistakes,
  index,
  engaged,
  onSelect,
}: {
  mistakes: StudentMistakeView[];
  index: number;
  engaged: ReadonlySet<number>;
  onSelect: (index: number) => void;
}) {
  const doneCount = mistakes.filter((m) =>
    engaged.has(m.questionNumber),
  ).length;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          Question {index + 1} of {mistakes.length}
        </span>
        <span>
          {doneCount} of {mistakes.length} talked through
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${((index + 1) / mistakes.length) * 100}%` }}
        />
      </div>
      {mistakes.length > 1 && (
        <div
          role="group"
          aria-label="Missed questions"
          className="flex gap-1.5 overflow-x-auto pb-0.5"
        >
          {mistakes.map((mistake, at) => {
            const current = at === index;
            const done = engaged.has(mistake.questionNumber);
            return (
              <button
                key={mistake.questionNumber}
                type="button"
                onClick={() => onSelect(at)}
                aria-current={current ? "step" : undefined}
                aria-label={`Question ${mistake.questionNumber}${done ? " (talked through)" : ""}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  current
                    ? "border-primary bg-primary text-primary-foreground"
                    : done
                      ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                      : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {done && <Check className="size-3" aria-hidden />}Q
                {mistake.questionNumber}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The missed question on its own, when the assistant is switched off. */
function MissedQuestionCard({ mistake }: { mistake: StudentMistakeView }) {
  const { response } = mistake;
  return (
    <Card className="border-destructive/35">
      <CardContent className="space-y-3 p-5">
        {mistake.figureUrl && (
          // Short-lived presigned S3 URL; next/image cannot serve it.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mistake.figureUrl}
            alt={mistake.figureAlt ?? "Question figure"}
            loading="lazy"
            className="max-h-64 rounded-md border"
          />
        )}
        <p className="flex items-start gap-2 text-sm font-medium">
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            {mistake.questionNumber}. <MathText text={mistake.text} />
          </span>
        </p>
        <div className="ml-6 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Your answer
          </p>
          {response.kind === "numeric" ? (
            <p className="rounded bg-destructive/10 px-2 py-1 text-sm text-destructive">
              {response.value === null ? (
                "No answer"
              ) : (
                <MathText
                  text={
                    response.unit
                      ? `${response.value} ${response.unit}`
                      : String(response.value)
                  }
                />
              )}
            </p>
          ) : response.choices.length === 0 ? (
            <p className="rounded bg-destructive/10 px-2 py-1 text-sm text-destructive">
              No answer
            </p>
          ) : (
            response.choices.map((choice, at) => (
              <div
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only list that is never reordered
                key={`${choice.text}-${choice.imageAlt ?? ""}-${at}`}
                className="flex items-center gap-2 rounded bg-destructive/10 px-2 py-1 text-sm text-destructive"
              >
                {choice.imageUrl && (
                  // Short-lived presigned S3 URL, like the figure above.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={choice.imageUrl}
                    alt={choice.imageAlt ?? "Submitted answer choice"}
                    loading="lazy"
                    className="max-h-28 rounded border bg-white"
                  />
                )}
                {choice.text ? (
                  <MathText text={choice.text} />
                ) : (
                  !choice.imageUrl && (
                    <MathText text={choice.imageAlt || "Image"} />
                  )
                )}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Step 2: one missed question at a time, with the coach embedded right on the
 * page. The workspace is keyed per question, so moving on starts that
 * question's own conversation (or reloads the saved one).
 */
export function CoachStep({
  attemptId,
  mistakes,
  index,
  onIndexChange,
  engaged,
  onEngaged,
  nextLabel,
  onFinish,
}: {
  attemptId: string;
  mistakes: StudentMistakeView[];
  index: number;
  onIndexChange: (index: number) => void;
  engaged: ReadonlySet<number>;
  onEngaged: (questionNumber: number) => void;
  /** The button label on the last question (the step after this one). */
  nextLabel: string;
  onFinish: () => void;
}) {
  const assistant = useOptionalAssistant();
  const coachOn =
    !!assistant?.config?.available && assistant.config.audience === "student";
  const current = mistakes[index] ?? mistakes[0];
  const questionNumber = current.questionNumber;
  const isLast = index >= mistakes.length - 1;
  const hasEngaged = engaged.has(questionNumber);

  const target = useMemo(
    () => ({ attemptId, questionNumber }),
    [attemptId, questionNumber],
  );
  const markEngaged = useCallback(
    (value: boolean) => {
      if (value) onEngaged(questionNumber);
    },
    [onEngaged, questionNumber],
  );

  const advance = () => (isLast ? onFinish() : onIndexChange(index + 1));
  const advanceLabel = isLast ? nextLabel : "Next Question";

  return (
    <section aria-labelledby="guided-coach-title" className="space-y-5">
      <div id="guided-coach-title">
        <StepHeader
          icon={
            <MessageCircleQuestion
              className="size-5 text-primary"
              aria-hidden
            />
          }
          title="Review your missed questions"
        >
          {coachOn
            ? "Go through each question you missed with the coach. Tell it how you approached the question first — it will take it from there."
            : "Go through each question you missed and think about where your reasoning went off track."}
        </StepHeader>
      </div>

      <QuestionStrip
        mistakes={mistakes}
        index={index}
        engaged={engaged}
        onSelect={onIndexChange}
      />

      {coachOn ? (
        <Card className="relative flex h-[min(80dvh,760px)] min-h-[520px] flex-col overflow-hidden">
          <CoachWorkspace
            key={`${attemptId}:${questionNumber}`}
            target={target}
            onEngaged={markEngaged}
          />
        </Card>
      ) : (
        <MissedQuestionCard mistake={current} />
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {coachOn && !hasEngaged ? (
          <>
            <p className="mr-auto text-sm text-muted-foreground">
              Share your thoughts with the coach above to get personalized help.
            </p>
            <button
              type="button"
              onClick={advance}
              className="text-xs text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Skip this question
            </button>
          </>
        ) : (
          <AdvanceButton label={advanceLabel} onClick={advance} />
        )}
      </div>
    </section>
  );
}
