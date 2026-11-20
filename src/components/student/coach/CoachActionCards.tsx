"use client";

import { useEffect, useRef, useState } from "react";
import {
  Atom,
  Check,
  CheckCircle2,
  Dumbbell,
  Eye,
  Loader2,
  MessageSquareMore,
  XCircle,
} from "lucide-react";
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
import {
  saveCardInteraction,
  type CardInteraction,
  type CardScope,
  type CardSource,
} from "./card-interaction";

type CardOf<K extends CoachActionView["kind"]> = Extract<
  CoachActionView,
  { kind: K }
>;

/** What every card needs from the list it sits in. */
type CardContext = {
  scope: CardScope;
  source: CardSource;
  target?: CoachTarget;
  readOnly: boolean;
  onReport: (message: string) => void;
  onInteractionSaved?: (
    cardId: string | undefined,
    interaction: CardInteraction,
  ) => void;
};

/**
 * "Why this" line shared by every card. Written by the model, rendered with
 * math support (never raw HTML).
 */
function Reason({ children }: { children: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      <MathText text={children} />
    </p>
  );
}

/** Small "done" marker on a card the student already used. */
function DoneBadge({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-600/10 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:text-green-400">
      <Check className="size-3" aria-hidden /> {children}
    </span>
  );
}

/**
 * False once the card unmounts. The transcript is keyed per conversation, so a
 * request that finishes after the student switched conversations finds its
 * card gone and must not report into (or update) the one now on screen.
 */
function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * Record an interaction and let the transcript keep the saved copy. Resolves
 * to whether the server recorded it; a stale (unmounted) card resolves false
 * without touching the transcript.
 */
async function persist(
  ctx: CardContext,
  input: Parameters<typeof saveCardInteraction>[1],
  mounted: { current: boolean },
): Promise<boolean> {
  const saved = await saveCardInteraction(ctx.scope, input);
  if (!saved || !mounted.current) return false;
  ctx.onInteractionSaved?.(input.cardId, saved);
  return true;
}

/**
 * A "done" badge for a one-shot open (material viewed, simulation explored).
 * Shown optimistically on click; if the server never records it, the badge is
 * withdrawn so the next open tries again instead of claiming a saved state.
 */
function useRecordedOpen(
  initiallyRecorded: boolean,
  ctx: CardContext,
  input: Parameters<typeof saveCardInteraction>[1],
) {
  const mounted = useMountedRef();
  const [shown, setShown] = useState(initiallyRecorded);
  const recorded = useRef(initiallyRecorded);
  const inFlight = useRef(false);
  const record = () => {
    setShown(true);
    if (ctx.readOnly || recorded.current || inFlight.current) return;
    inFlight.current = true;
    void persist(ctx, input, mounted).then((ok) => {
      inFlight.current = false;
      if (!mounted.current) return;
      recorded.current = ok;
      if (!ok) setShown(false);
    });
  };
  return [shown, record] as const;
}

function MaterialCard({
  card,
  ctx,
}: {
  card: CardOf<"material">;
  ctx: CardContext;
}) {
  const [viewed, markViewed] = useRecordedOpen(
    card.interaction?.status === "viewed",
    ctx,
    {
      cardId: card.cardId,
      kind: "material",
      materialId: card.recommendation.materialId ?? undefined,
      recommendationIndex: card.recommendationIndex,
    },
  );
  // Every open counts as a recommendation open: the surface tells the coach's
  // cards apart from the widget's, and the attempt ties it to the quiz.
  const attemptId = card.attemptId ?? ctx.target?.attemptId;
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <Reason>{card.reason}</Reason>
        {viewed && <DoneBadge>Viewed</DoneBadge>}
      </div>
      <RecommendationCard
        rec={card.recommendation}
        attemptId={attemptId}
        telemetrySurface={
          ctx.source === "widget"
            ? "assistant_recommendation"
            : "coach_recommendation"
        }
        onOpen={markViewed}
      />
    </div>
  );
}

function SimulationCard({
  card,
  ctx,
}: {
  card: CardOf<"simulation">;
  ctx: CardContext;
}) {
  const [open, setOpen] = useState(false);
  const { simulation } = card;
  const [explored, markExplored] = useRecordedOpen(
    card.interaction?.status === "opened",
    ctx,
    {
      cardId: card.cardId,
      kind: "simulation",
      simulationId: simulation.simulationId,
    },
  );
  return (
    <section
      aria-label={`How to use the ${simulation.title} simulation`}
      className="space-y-2 rounded-xl border bg-card p-3 text-sm shadow-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <Atom className="size-4" aria-hidden /> Try this simulation
        </p>
        {explored && <DoneBadge>Explored</DoneBadge>}
      </div>
      <p className="font-medium">{simulation.title}</p>
      <p className="text-xs text-muted-foreground">
        <MathText text={card.goal} />
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        {card.steps.map((step, index) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- fixed, ordered steps; model text can repeat
          <li key={`${index}-${step}`}>
            <MathText text={step} />
          </li>
        ))}
      </ol>
      <p>
        <span className="font-medium">What to watch: </span>
        <MathText text={card.observe} />
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          markExplored();
        }}
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
          telemetry={{
            attemptId: card.attemptId ?? ctx.target?.attemptId ?? null,
            surface:
              ctx.source === "widget"
                ? "assistant_recommendation"
                : "coach_recommendation",
          }}
        />
      )}
    </section>
  );
}

function DiagnosticCard({
  card,
  ctx,
}: {
  card: CardOf<"diagnostic_options">;
  ctx: CardContext;
}) {
  const saved =
    card.interaction?.status === "selected" ? card.interaction : null;
  const [selected, setSelected] = useState<{
    id?: string;
    label: string;
  } | null>(
    saved ? { id: saved.selectedOptionId, label: saved.selectedLabel } : null,
  );
  const mounted = useMountedRef();
  // Synchronous: a second click lands before React re-renders the lock.
  const choosing = useRef(false);
  const locked = selected !== null || ctx.readOnly;
  const isChosen = (option: { id: string; label: string }) =>
    selected !== null &&
    (selected.id ? selected.id === option.id : selected.label === option.label);

  const choose = async (option: { id: string; label: string }) => {
    if (locked || choosing.current) return;
    choosing.current = true;
    setSelected({ id: option.id, label: option.label });
    // Saved before the report, so the coach's next turn reads the selection
    // from the stored transcript. A failed save still reports: the choice is
    // in the student's message either way.
    await persist(
      ctx,
      {
        cardId: card.cardId,
        kind: "diagnostic_options",
        selectedOptionId: option.id,
        selectedLabel: option.label,
      },
      mounted,
    );
    if (!mounted.current) return;
    ctx.onReport(option.label);
  };

  return (
    <section
      aria-label="Which of these sounds like you?"
      className="space-y-2 rounded-xl border border-primary/25 bg-primary/[0.03] p-3 text-sm"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <MessageSquareMore className="size-4" aria-hidden /> Pick what fits
      </p>
      <p className="font-medium">
        <MathText text={card.prompt} />
      </p>
      <div role="group" aria-label={card.prompt} className="grid gap-1.5">
        {card.options.map((option) => {
          const chosen = isChosen(option);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => void choose(option)}
              disabled={locked && !chosen}
              aria-pressed={chosen}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-[color,background-color,border-color,box-shadow,transform]",
                chosen
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border bg-background",
                !locked &&
                  "hover:border-primary/60 hover:bg-primary/5 hover:shadow-xs active:scale-[0.99]",
                locked && !chosen && "opacity-50",
                locked && "cursor-default",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                  chosen
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/50",
                )}
              >
                {chosen && <Check className="size-3" />}
              </span>
              <span className="flex-1">
                <MathText text={option.label} />
              </span>
              {chosen && (
                <span className="text-[11px] font-semibold text-primary">
                  Selected
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

type PracticeState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "error"; message: string }
  | { status: "done"; correct: boolean; selectedText: string };

function initialPracticeState(card: CardOf<"practice">): PracticeState {
  const saved = card.interaction;
  return saved?.status === "completed"
    ? {
        status: "done",
        correct: saved.correct,
        selectedText: saved.selectedText,
      }
    : { status: "idle" };
}

/** Grade one practice answer on the server. */
async function checkPractice(
  body: Record<string, unknown>,
  fallbackText: string,
): Promise<
  | {
      ok: true;
      correct: boolean;
      selectedText: string;
      result: CoachPracticeResult;
    }
  | { ok: false; message: string }
> {
  try {
    const res = await fetch("/api/assistant/coach/practice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      return {
        ok: false,
        message:
          res.status === 429
            ? "This practice question has already been checked today. Try another question."
            : "That practice question is not available right now.",
      };
    const result = (await res.json()) as CoachPracticeResult;
    return {
      ok: true,
      correct: result.correct,
      selectedText: result.selectedText ?? fallbackText,
      result,
    };
  } catch {
    return { ok: false, message: "Could not check your answer." };
  }
}

function PracticeVerdict({
  correct,
  selectedText,
}: {
  correct: boolean;
  selectedText: string;
}) {
  return (
    <div className="space-y-0.5" role="status">
      <p
        className={cn(
          "flex items-center gap-1.5 font-medium",
          correct ? "text-green-700 dark:text-green-400" : "text-destructive",
        )}
      >
        {correct ? (
          <CheckCircle2 className="size-4" aria-hidden />
        ) : (
          <XCircle className="size-4" aria-hidden />
        )}
        {correct ? "Correct!" : "Not quite."}
      </p>
      {selectedText && (
        <p className="text-xs text-muted-foreground">
          You answered: <MathText text={selectedText} />
        </p>
      )}
    </div>
  );
}

function PracticeAnswerInput({
  question,
  name,
  locked,
  choice,
  onChoice,
  numeric,
  onNumeric,
}: {
  question: CoachPracticeQuestionView;
  name: string;
  locked: boolean;
  choice: string | null;
  onChoice: (id: string) => void;
  numeric: string;
  onNumeric: (value: string) => void;
}) {
  if (question.answerMode === "NUMERIC")
    return (
      <div className="flex items-center gap-2">
        <Input
          inputMode="decimal"
          value={numeric}
          onChange={(event) => onNumeric(event.target.value)}
          disabled={locked}
          aria-label="Your numeric answer"
          className="max-w-40"
        />
        {question.answerUnit && <MathText text={question.answerUnit} />}
      </div>
    );
  return (
    <fieldset className="space-y-1" disabled={locked}>
      <legend className="sr-only">Choose one answer</legend>
      {question.options.map((option) => (
        <label
          key={option.id}
          className={cn(
            "flex items-start gap-2 rounded-md border px-2 py-1.5",
            locked ? "cursor-default" : "cursor-pointer",
            choice === option.id && "border-primary bg-primary/5",
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.id}
            checked={choice === option.id}
            onChange={() => onChoice(option.id)}
            className="mt-1"
          />
          <MathText text={option.text} />
        </label>
      ))}
    </fieldset>
  );
}

function PracticeQuestion({
  card,
  question,
  target,
  ctx,
}: {
  card: CardOf<"practice">;
  question: CoachPracticeQuestionView;
  target: CoachTarget;
  ctx: CardContext;
}) {
  const saved =
    card.interaction?.status === "completed" ? card.interaction : null;
  const [choice, setChoice] = useState<string | null>(
    saved?.selectedOptionId ?? null,
  );
  const [numeric, setNumeric] = useState(
    saved?.numericValue != null ? String(saved.numericValue) : "",
  );
  const [state, setState] = useState<PracticeState>(() =>
    initialPracticeState(card),
  );
  const mounted = useMountedRef();
  // Synchronous double-submit guard: `state` only locks after a re-render.
  const submitting = useRef(false);
  const numericMode = question.answerMode === "NUMERIC";
  const ready = numericMode ? numeric.trim() !== "" : choice !== null;
  const locked =
    ctx.readOnly || state.status === "submitting" || state.status === "done";

  const submit = async () => {
    if (!ready || locked || submitting.current) return;
    submitting.current = true;
    setState({ status: "submitting" });
    const answer = numericMode
      ? { numericValue: numeric.trim() }
      : { selectedOptionId: choice };
    const outcome = await checkPractice(
      {
        ...target,
        versionId: question.versionId,
        questionId: question.questionId,
        ...answer,
        conversationId: ctx.scope.conversationId ?? undefined,
        cardId: card.cardId,
        source: ctx.source,
      },
      numericMode
        ? numeric.trim()
        : (question.options.find((o) => o.id === choice)?.text ?? ""),
    );
    // The student moved to another conversation or question meanwhile: this
    // result belongs to a transcript that is no longer on screen.
    if (!mounted.current) return;
    submitting.current = false;
    if (!outcome.ok) {
      setState({ status: "error", message: outcome.message });
      return;
    }
    const { correct, selectedText, result } = outcome;
    setState({ status: "done", correct, selectedText });
    if (result.interaction)
      ctx.onInteractionSaved?.(card.cardId, result.interaction);
    // Tell the coach straight away, so its next reply can react to the result
    // without the student having to explain what happened.
    ctx.onReport(
      `I answered the practice question with "${selectedText}" and got it ${correct ? "right" : "wrong"}.`,
    );
  };

  return (
    <form className="space-y-2" action={submit}>
      <p className="font-medium">
        <MathText text={question.text} />
      </p>
      <PracticeAnswerInput
        question={question}
        name={`practice-${card.cardId ?? question.questionId}`}
        locked={locked}
        choice={choice}
        onChoice={setChoice}
        numeric={numeric}
        onNumeric={setNumeric}
      />
      {state.status === "done" && (
        <PracticeVerdict
          correct={state.correct}
          selectedText={state.selectedText}
        />
      )}
      {state.status !== "done" && !ctx.readOnly && (
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
  ctx,
}: {
  card: CardOf<"practice">;
  target: CoachTarget;
  ctx: CardContext;
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
        card={card}
        question={card.question}
        target={target}
        ctx={ctx}
      />
    </section>
  );
}

/** The structured cards under one assistant reply. */
export function CoachActionCards({
  actions,
  target,
  conversationId,
  source,
  onReport,
  onInteractionSaved,
  readOnly = false,
}: {
  actions: CoachActionView[];
  /** The missed question these cards belong to (coach chats). */
  target?: CoachTarget;
  /** The transcript the cards were shown in; interactions are filed under it. */
  conversationId?: string | null;
  /** Coach dialog or study-assistant widget; defaults from `target`. */
  source?: CardSource;
  /** Send a message to the assistant as the student's next turn. */
  onReport: (message: string) => void;
  /** The server's saved copy of an interaction, for the local transcript. */
  onInteractionSaved?: (
    cardId: string | undefined,
    interaction: CardInteraction,
  ) => void;
  /** Show saved state only; nothing can be clicked or submitted. */
  readOnly?: boolean;
}) {
  const ctx: CardContext = {
    scope: { conversationId, target },
    source: source ?? (target ? "coach" : "widget"),
    target,
    readOnly,
    onReport,
    onInteractionSaved,
  };
  return (
    <>
      {actions.map((action, index) => {
        // Index-suffixed: the model may surface the same material twice. The
        // card id keeps a different card at the same slot from inheriting
        // another card's local state.
        switch (action.kind) {
          case "material":
            return (
              <MaterialCard
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a card list that is append-only; the model may repeat an id
                key={`m-${index}-${action.cardId ?? ""}-${action.recommendation.materialId ?? action.recommendation.materialTitle}`}
                card={action}
                ctx={ctx}
              />
            );
          case "simulation":
            return (
              <SimulationCard
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a card list that is append-only; the model may repeat an id
                key={`s-${index}-${action.cardId ?? ""}-${action.simulation.simulationId}`}
                card={action}
                ctx={ctx}
              />
            );
          case "diagnostic_options":
            return (
              <DiagnosticCard
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a card list that is append-only; prompts can repeat
                key={`d-${index}-${action.cardId ?? ""}-${action.prompt}`}
                card={action}
                ctx={ctx}
              />
            );
          case "practice": {
            const practiceTarget = action.target ?? target;
            if (!practiceTarget) return null;
            return (
              <PracticeCard
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- a card list that is append-only; the model may repeat an id
                key={`p-${index}-${action.cardId ?? ""}-${action.question.versionId}-${action.question.questionId}`}
                card={action}
                target={practiceTarget}
                ctx={ctx}
              />
            );
          }
        }
      })}
    </>
  );
}
