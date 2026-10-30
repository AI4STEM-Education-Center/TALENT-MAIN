"use client";

import { useState } from "react";
import { Atom, CheckCircle2, Dumbbell, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MathText } from "@/components/ui/math-text";
import { RecommendationCard } from "@/components/student/RecommendationCard";
import { SimulationDialog } from "@/components/simulation/SimulationDialog";
import { cn } from "@/lib/utils";
import type {
  CoachActionView,
  CoachPracticeQuestionView,
  CoachPracticeResult,
} from "@/lib/assistant/coach-types";
import type { CoachTarget } from "./use-coach-chat";

type CardOf<K extends CoachActionView["kind"]> = Extract<
  CoachActionView,
  { kind: K }
>;

/**
 * "Why this" line shared by every card. Written by the model, shown as plain
 * text (never markup).
 */
function Reason({ children }: { children: string }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function MaterialCard({ card }: { card: CardOf<"material"> }) {
  // No attemptId / telemetry surface on purpose: this card is not one of the
  // results page's recommendations, so opening it neither records a learning
  // session under that surface nor asks for a rating.
  return (
    <div className="space-y-1.5">
      <Reason>{card.reason}</Reason>
      <RecommendationCard rec={card.recommendation} />
    </div>
  );
}

function SimulationCard({ card }: { card: CardOf<"simulation"> }) {
  const [open, setOpen] = useState(false);
  const { simulation } = card;
  return (
    <section
      aria-label={`How to use the ${simulation.title} simulation`}
      className="space-y-2 rounded-xl border bg-card p-3 text-sm shadow-xs"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Atom className="size-4" aria-hidden /> Try this simulation
      </p>
      <p className="font-medium">{simulation.title}</p>
      <p className="text-xs text-muted-foreground">{card.goal}</p>
      <ol className="list-decimal space-y-1 pl-5">
        {card.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p>
        <span className="font-medium">What to watch: </span>
        {card.observe}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Open simulation
      </Button>
      {open && (
        <SimulationDialog
          simulation={{
            simulationId: simulation.simulationId,
            title: simulation.title,
            version: simulation.version,
          }}
          onClose={() => setOpen(false)}
          description={simulation.learningGoal}
        />
      )}
    </section>
  );
}

type PracticeState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string }
  | { status: "done"; correct: boolean };

function PracticeQuestion({
  question,
  target,
  onReport,
}: {
  question: CoachPracticeQuestionView;
  target: CoachTarget;
  onReport: (message: string) => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [numeric, setNumeric] = useState("");
  const [state, setState] = useState<PracticeState>({ status: "idle" });
  const numericMode = question.answerMode === "NUMERIC";
  const ready = numericMode ? numeric.trim() !== "" : choice !== null;
  const locked = state.status === "submitting" || state.status === "done";

  const submit = async () => {
    if (!ready || locked) return;
    setState({ status: "submitting" });
    try {
      const res = await fetch("/api/assistant/coach/practice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...target,
          versionId: question.versionId,
          questionId: question.questionId,
          ...(numericMode
            ? { numericValue: numeric.trim() }
            : { selectedOptionId: choice }),
        }),
      });
      if (!res.ok) {
        setState({
          status: "error",
          message:
            res.status === 429
              ? "This practice question has already been checked today. Try another question."
              : "That practice question is not available right now.",
        });
        return;
      }
      const data = (await res.json()) as CoachPracticeResult;
      setState({ status: "done", correct: data.correct });
    } catch {
      setState({ status: "error", message: "Could not check your answer." });
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="font-medium">
        <MathText text={question.text} />
      </p>
      {numericMode ? (
        <div className="flex items-center gap-2">
          <Input
            inputMode="decimal"
            value={numeric}
            onChange={(event) => setNumeric(event.target.value)}
            disabled={locked}
            aria-label="Your numeric answer"
            className="max-w-40"
          />
          {question.answerUnit && <MathText text={question.answerUnit} />}
        </div>
      ) : (
        <fieldset className="space-y-1" disabled={locked}>
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5",
                choice === option.id && "border-primary bg-primary/5",
              )}
            >
              <input
                type="radio"
                name={`practice-${question.questionId}`}
                value={option.id}
                checked={choice === option.id}
                onChange={() => setChoice(option.id)}
                className="mt-1"
              />
              <MathText text={option.text} />
            </label>
          ))}
        </fieldset>
      )}

      {state.status === "done" ? (
        <div className="space-y-2" role="status">
          <p
            className={cn(
              "flex items-center gap-1.5 font-medium",
              state.correct ? "text-green-700" : "text-destructive",
            )}
          >
            {state.correct ? (
              <CheckCircle2 className="size-4" aria-hidden />
            ) : (
              <XCircle className="size-4" aria-hidden />
            )}
            {state.correct ? "Correct!" : "Not quite."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onReport(
                state.correct
                  ? "I tried the practice question and got it right."
                  : "I tried the practice question and got it wrong.",
              )
            }
          >
            Tell the assistant how it went
          </Button>
        </div>
      ) : (
        <Button type="submit" size="sm" disabled={!ready || locked}>
          {state.status === "submitting" && (
            <Loader2 className="animate-spin" aria-hidden />
          )}
          Check my answer
        </Button>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      )}
    </form>
  );
}

function PracticeCard({
  card,
  target,
  onReport,
}: {
  card: CardOf<"practice">;
  target: CoachTarget;
  onReport: (message: string) => void;
}) {
  return (
    <section
      aria-label="Practice question"
      className="space-y-2 rounded-xl border bg-card p-3 text-sm shadow-xs"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <Dumbbell className="size-4" aria-hidden /> Try a similar question
      </p>
      <Reason>{card.reason}</Reason>
      <PracticeQuestion
        question={card.question}
        target={target}
        onReport={onReport}
      />
    </section>
  );
}

/** The structured cards under one coach reply. */
export function CoachActionCards({
  actions,
  target,
  onReport,
}: {
  actions: CoachActionView[];
  target: CoachTarget;
  onReport: (message: string) => void;
}) {
  return (
    <>
      {actions.map((action) => {
        switch (action.kind) {
          case "material":
            return (
              <MaterialCard
                key={`m-${action.recommendation.materialId ?? action.recommendation.materialTitle}`}
                card={action}
              />
            );
          case "simulation":
            return (
              <SimulationCard
                key={`s-${action.simulation.simulationId}`}
                card={action}
              />
            );
          case "practice":
            return (
              <PracticeCard
                key={`p-${action.question.versionId}-${action.question.questionId}`}
                card={action}
                target={target}
                onReport={onReport}
              />
            );
        }
      })}
    </>
  );
}
