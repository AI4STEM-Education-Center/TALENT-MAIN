"use client";

import { useState } from "react";
import {
  Atom,
  BookOpen,
  Check,
  CheckCircle2,
  Dumbbell,
  MessageSquareMore,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MathText } from "@/components/ui/math-text";
import { RecommendationCard } from "@/components/student/RecommendationCard";
import { SimulationDialog } from "@/components/simulation/SimulationDialog";
import { cn } from "@/lib/utils";
import type { CoachActionRef } from "@/lib/assistant/coach-types";
import type { AdminTranscriptCard } from "@/lib/assistant/admin-transcript-types";
import { readCardRef } from "./transcript-card-ref";

function optionLabel(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26 ? letter : optionLabel(Math.floor(index / 26) - 1) + letter;
}

function Tag({
  tone,
  children,
}: {
  tone: "good" | "bad" | "info" | "neutral";
  children: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        tone === "good" && "bg-green-600/10 text-green-700 dark:text-green-400",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "info" && "bg-primary/10 text-primary",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Convert an unhydrated stored ref into a fallback AdminTranscriptCard. */
function refToFallbackCard(ref: CoachActionRef): AdminTranscriptCard {
  switch (ref.kind) {
    case "diagnostic_options":
      return ref;
    case "material":
      return {
        kind: "material",
        cardId: ref.cardId,
        recommendationIndex: ref.recommendationIndex,
        reason: ref.reason,
        recommendation: null,
        interaction: ref.interaction,
      };
    case "simulation":
      return {
        kind: "simulation",
        cardId: ref.cardId,
        simulationId: ref.simulationId,
        simulation: null,
        goal: ref.goal,
        steps: ref.steps,
        observe: ref.observe,
        interaction: ref.interaction,
      };
    case "practice":
      return {
        kind: "practice",
        cardId: ref.cardId,
        versionId: ref.versionId,
        variantQuestionId: ref.variantQuestionId,
        reason: ref.reason,
        questionText: ref.questionText,
        question: null,
        interaction: ref.interaction,
      };
  }
}

function AdminMaterialCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "material" }>;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border/80 bg-background p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold text-foreground">
          <BookOpen className="size-3.5 text-primary" aria-hidden />
          Course material
        </p>
        {card.interaction && <Tag tone="info">Viewed</Tag>}
      </div>
      <p className="text-muted-foreground">
        <MathText text={card.reason} />
      </p>
      {card.recommendation ? (
        // Read-only admin view: omit `attemptId` and `telemetrySurface` so the
        // card shows the actual title, pages, thumbnail, and full-size viewer
        // without rendering a student rating form or recording telemetry.
        <RecommendationCard rec={card.recommendation} audience="teacher" />
      ) : (
        <p className="rounded-md border border-dashed border-border/80 px-2.5 py-2 text-muted-foreground">
          Recommendation {card.recommendationIndex + 1} · Course material
          preview is no longer available.
        </p>
      )}
    </div>
  );
}

function AdminDiagnosticCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "diagnostic_options" }>;
}) {
  const saved =
    card.interaction?.status === "selected" ? card.interaction : null;
  const isChosen = (option: { id: string; label: string }) =>
    saved !== null &&
    (saved.selectedOptionId
      ? saved.selectedOptionId === option.id
      : saved.selectedLabel === option.label);
  const matchedAny = saved !== null && card.options.some(isChosen);

  return (
    <div className="space-y-2 rounded-lg border border-primary/25 bg-background p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold text-primary">
          <MessageSquareMore className="size-3.5" aria-hidden />
          Diagnostic options
        </p>
        {saved && <Tag tone="info">Chosen</Tag>}
      </div>
      <p className="text-sm font-medium text-foreground">
        <MathText text={card.prompt} />
      </p>
      <ul className="space-y-1.5">
        {card.options.map((option) => {
          const chosen = isChosen(option);
          return (
            <li
              key={option.id}
              className={cn(
                "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                chosen
                  ? "border-primary bg-primary/10 font-medium text-foreground"
                  : "border-border bg-muted/20 text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  chosen
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40",
                )}
              >
                {chosen && <Check className="size-2.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <MathText text={option.label} />
              </span>
              {chosen && <Tag tone="info">Selected</Tag>}
            </li>
          );
        })}
      </ul>
      {saved && !matchedAny && (
        <p className="text-muted-foreground">
          <MathText text={`Selected “${saved.selectedLabel}”`} />
        </p>
      )}
    </div>
  );
}

function AdminPracticeNumeric({
  answerNumeric,
  answerUnit,
  interaction,
}: {
  answerNumeric: number | null;
  answerUnit: string | null;
  interaction: Extract<
    AdminTranscriptCard,
    { kind: "practice" }
  >["interaction"];
}) {
  return (
    <div className="space-y-1.5">
      {interaction && (
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs",
            interaction.correct
              ? "border-green-600/40 bg-green-600/5 text-green-700 dark:text-green-400"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {interaction.correct ? (
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <XCircle className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="font-semibold">Student&apos;s answer:</span>
          <MathText text={interaction.selectedText} />
        </div>
      )}
      {answerNumeric !== null && (
        <div className="flex items-center gap-1.5 rounded-md border border-green-600/40 bg-green-600/5 px-2.5 py-1.5 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          <span className="font-semibold">Correct answer:</span>
          <MathText
            text={
              answerUnit
                ? `${answerNumeric} ${answerUnit}`
                : String(answerNumeric)
            }
          />
        </div>
      )}
    </div>
  );
}

function AdminPracticeOptions({
  options,
  interaction,
}: {
  options: { id: string; text: string; isCorrect: boolean }[];
  interaction: Extract<
    AdminTranscriptCard,
    { kind: "practice" }
  >["interaction"];
}) {
  return (
    <ul className="space-y-1.5">
      {options.map((option, index) => {
        const selected =
          interaction !== undefined &&
          (interaction.selectedOptionId
            ? interaction.selectedOptionId === option.id
            : interaction.selectedText === option.text);
        const tone = option.isCorrect
          ? "right"
          : selected
            ? "wrong"
            : "neutral";
        return (
          <li
            key={option.id}
            className={cn(
              "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              tone === "right" &&
                "border-green-600/40 bg-green-600/5 text-foreground",
              tone === "wrong" &&
                "border-destructive/40 bg-destructive/5 text-foreground",
              tone === "neutral" &&
                "border-border bg-muted/20 text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded border text-[11px] font-bold",
                tone === "right" && "border-green-600 bg-green-600 text-white",
                tone === "wrong" &&
                  "border-destructive bg-destructive text-destructive-foreground",
                tone === "neutral" &&
                  "border-border bg-muted text-muted-foreground",
              )}
            >
              {optionLabel(index)}
            </span>
            <span className="min-w-0 flex-1 pt-0.5">
              <MathText text={option.text} />
            </span>
            {selected && option.isCorrect && (
              <Tag tone="good">Student&apos;s answer · correct</Tag>
            )}
            {selected && !option.isCorrect && (
              <Tag tone="bad">Student&apos;s answer</Tag>
            )}
            {!selected && option.isCorrect && <Tag tone="good">Correct</Tag>}
          </li>
        );
      })}
    </ul>
  );
}

function AdminPracticeCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "practice" }>;
}) {
  const interaction =
    card.interaction?.status === "completed" ? card.interaction : undefined;
  const { question } = card;

  return (
    <div className="space-y-2 rounded-lg border border-border/80 bg-background p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold text-foreground">
          <Dumbbell className="size-3.5 text-primary" aria-hidden />
          Practice question
          {question?.versionName && (
            <span className="font-normal text-muted-foreground">
              · {question.versionName}
            </span>
          )}
        </p>
        {interaction ? (
          <Tag tone={interaction.correct ? "good" : "bad"}>
            {interaction.correct ? "Correct" : "Incorrect"}
          </Tag>
        ) : (
          <Tag tone="neutral">Not answered</Tag>
        )}
      </div>

      <p className="text-muted-foreground">
        <MathText text={card.reason} />
      </p>

      {question ? (
        <div className="space-y-2 border-t border-border/60 pt-2">
          <p className="text-sm font-medium text-foreground">
            <MathText text={question.text} />
          </p>
          {question.answerMode === "NUMERIC" ? (
            <AdminPracticeNumeric
              answerNumeric={question.answerNumeric}
              answerUnit={question.answerUnit}
              interaction={interaction}
            />
          ) : (
            <AdminPracticeOptions
              options={question.options}
              interaction={interaction}
            />
          )}
        </div>
      ) : (
        <div className="space-y-1 border-t border-border/60 pt-2">
          {card.questionText && (
            <p className="text-sm font-medium text-foreground">
              <MathText text={card.questionText} />
            </p>
          )}
          {interaction && (
            <p className="text-muted-foreground">
              <MathText text={`Answered “${interaction.selectedText}”`} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AdminSimulationCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "simulation" }>;
}) {
  const [open, setOpen] = useState(false);
  const { simulation } = card;

  return (
    <div className="space-y-2 rounded-lg border border-border/80 bg-background p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold text-foreground">
          <Atom className="size-3.5 text-primary" aria-hidden />
          Simulation guide
        </p>
        {card.interaction && <Tag tone="info">Opened</Tag>}
      </div>
      {simulation && (
        <p className="text-sm font-medium text-foreground">
          {simulation.title}
        </p>
      )}
      <p className="text-muted-foreground">
        <MathText text={card.goal} />
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-foreground">
        {card.steps.map((step, index) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- fixed ordered steps; text can repeat
          <li key={`${index}-${step}`}>
            <MathText text={step} />
          </li>
        ))}
      </ol>
      <p className="text-foreground">
        <span className="font-medium">What to watch: </span>
        <MathText text={card.observe} />
      </p>
      {simulation?.playable && (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            Open current simulation
          </Button>
          {open && (
            <SimulationDialog
              simulation={{
                simulationId: simulation.simulationId,
                title: simulation.title,
                version: simulation.version,
              }}
              description={simulation.learningGoal}
              context="Showing the current published version of this simulation."
              onClose={() => setOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Rich, read-only cards for one assistant turn in the Admin Chat Transcripts
 * dialog. Uses server-hydrated `cards` when available (actual course material
 * pages, full diagnostic options, full practice question choices & key, and
 * playable simulation preview), falling back to defensive parsing of raw
 * `actions` refs when viewing unhydrated data.
 */
export function TranscriptCards({
  cards,
  actions,
}: {
  cards?: AdminTranscriptCard[];
  actions?: unknown[];
}) {
  const items: AdminTranscriptCard[] =
    cards && cards.length > 0
      ? cards
      : (actions ?? []).flatMap((raw) => {
          const ref = readCardRef(raw);
          return ref ? [refToFallbackCard(ref)] : [];
        });
  if (items.length === 0) return null;

  return (
    <ul
      aria-label="Cards shown with this reply"
      className="mt-2 space-y-2 border-t border-border/60 pt-2"
    >
      {items.map((card, index) => (
        <li
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only stored list, never reordered; legacy cards may lack cardId
          key={card.cardId ?? `${card.kind}-${index}`}
        >
          {card.kind === "material" && <AdminMaterialCard card={card} />}
          {card.kind === "diagnostic_options" && (
            <AdminDiagnosticCard card={card} />
          )}
          {card.kind === "practice" && <AdminPracticeCard card={card} />}
          {card.kind === "simulation" && <AdminSimulationCard card={card} />}
        </li>
      ))}
    </ul>
  );
}
