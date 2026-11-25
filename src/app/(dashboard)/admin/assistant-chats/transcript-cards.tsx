"use client";

import { useState, type ReactNode } from "react";
import {
  Atom,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Dumbbell,
  Maximize2,
  MessageSquareMore,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MathText } from "@/components/ui/math-text";
import { SimulationDialog } from "@/components/simulation/SimulationDialog";
import { cn } from "@/lib/utils";
import type { PresignedRecommendation } from "@/lib/exam-results";
import type { CoachActionRef } from "@/lib/assistant/coach-types";
import type { AdminTranscriptCard } from "@/lib/assistant/admin-transcript-types";
import { readCardRef } from "./transcript-card-ref";

function optionLabel(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26 ? letter : optionLabel(Math.floor(index / 26) - 1) + letter;
}

function pageRangeLabel(rec: PresignedRecommendation): string {
  const { start, end } = rec.pageRange;
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
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

/** Shared compact header row for every collapsible/pop-up card in the log. */
function CardToggleRow({
  icon,
  label,
  preview,
  badge,
  mode,
  expanded = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  preview: ReactNode;
  badge?: ReactNode;
  mode: "expand" | "popup";
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={mode === "expand" ? expanded : undefined}
      aria-haspopup={mode === "popup" ? "dialog" : undefined}
      className="relative flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {preview}
      </span>
      {badge}
      {mode === "popup" ? (
        <Maximize2
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      )}
    </button>
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

function AdminMaterialViewerDialog({
  rec,
  coachReason,
  open,
  onOpenChange,
}: {
  rec: PresignedRecommendation;
  coachReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[92vh] w-[95vw] max-w-5xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="pr-8">{rec.materialTitle}</DialogTitle>
          <DialogDescription>
            {pageRangeLabel(rec)}
            {coachReason ? (
              <>
                {" — "}
                <MathText text={coachReason} />
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <div className="relative snap-y snap-mandatory space-y-4 overflow-y-auto rounded-lg bg-muted/30 p-3">
          {rec.pages.map((pg) => (
            <figure key={pg.pageNumber} className="snap-start">
              {/* Presigned S3 URL; next/image cannot serve it without static patterns. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pg.imageUrl}
                alt={`Page ${pg.pageNumber} of ${rec.materialTitle}`}
                loading="lazy"
                className="mx-auto max-h-[75vh] w-auto max-w-full rounded-md bg-background object-contain shadow-xs"
              />
              <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">
                Page {pg.pageNumber}
              </figcaption>
            </figure>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdminMaterialCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "material" }>;
}) {
  const [open, setOpen] = useState(false);
  const rec = card.recommendation;
  const hasPages = Boolean(rec && rec.pages.length > 0);
  const preview = rec
    ? `${rec.materialTitle} · ${pageRangeLabel(rec)}`
    : `Recommendation ${card.recommendationIndex + 1}`;

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-background text-xs">
      <CardToggleRow
        icon={<BookOpen className="size-3.5 text-primary" aria-hidden />}
        label="Course material"
        preview={preview}
        badge={card.interaction ? <Tag tone="info">Viewed</Tag> : undefined}
        mode={hasPages ? "popup" : "expand"}
        expanded={!hasPages && open}
        onClick={() => setOpen((value) => !value)}
      />
      {hasPages && rec && (
        <AdminMaterialViewerDialog
          rec={rec}
          coachReason={card.reason}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {!hasPages && open && (
        <div className="space-y-1.5 border-t border-border/60 px-3 py-2.5 text-muted-foreground">
          <p>
            <MathText text={card.reason} />
          </p>
          {rec?.reason && rec.reason !== card.reason && (
            <p>
              <MathText text={rec.reason} />
            </p>
          )}
          <p className="text-[11px] italic">
            Page previews are not available for this material.
          </p>
        </div>
      )}
    </div>
  );
}

function AdminDiagnosticCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "diagnostic_options" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const saved =
    card.interaction?.status === "selected" ? card.interaction : null;
  const isChosen = (option: { id: string; label: string }) =>
    saved !== null &&
    (saved.selectedOptionId
      ? saved.selectedOptionId === option.id
      : saved.selectedLabel === option.label);
  const matchedAny = saved !== null && card.options.some(isChosen);

  return (
    <div className="overflow-hidden rounded-lg border border-primary/25 bg-background text-xs">
      <CardToggleRow
        icon={
          <MessageSquareMore className="size-3.5 text-primary" aria-hidden />
        }
        label="Diagnostic options"
        preview={
          <MathText
            text={saved ? `Selected “${saved.selectedLabel}”` : card.prompt}
          />
        }
        badge={saved ? <Tag tone="info">Chosen</Tag> : undefined}
        mode="expand"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      />
      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
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
  const [expanded, setExpanded] = useState(false);
  const interaction =
    card.interaction?.status === "completed" ? card.interaction : undefined;
  const { question } = card;
  const previewText = question?.text ?? card.questionText ?? card.reason;

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-background text-xs">
      <CardToggleRow
        icon={<Dumbbell className="size-3.5 text-primary" aria-hidden />}
        label="Practice question"
        preview={<MathText text={previewText} />}
        badge={
          interaction ? (
            <Tag tone={interaction.correct ? "good" : "bad"}>
              {interaction.correct ? "Correct" : "Incorrect"}
            </Tag>
          ) : (
            <Tag tone="neutral">Not answered</Tag>
          )
        }
        mode="expand"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      />

      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
          {question?.versionName && (
            <p className="text-[11px] font-medium text-muted-foreground">
              {question.versionName}
            </p>
          )}
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
      )}
    </div>
  );
}

function AdminSimulationCard({
  card,
}: {
  card: Extract<AdminTranscriptCard, { kind: "simulation" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { simulation } = card;

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-background text-xs">
      <CardToggleRow
        icon={<Atom className="size-3.5 text-primary" aria-hidden />}
        label="Simulation guide"
        preview={simulation ? simulation.title : <MathText text={card.goal} />}
        badge={card.interaction ? <Tag tone="info">Opened</Tag> : undefined}
        mode="expand"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      />

      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
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
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-haspopup="dialog"
              onClick={() => setDialogOpen(true)}
            >
              Open current simulation
            </Button>
          )}
        </div>
      )}

      {dialogOpen && simulation?.playable && (
        <SimulationDialog
          simulation={{
            simulationId: simulation.simulationId,
            title: simulation.title,
            version: simulation.version,
          }}
          description={simulation.learningGoal}
          context="Showing the current published version of this simulation."
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Compact, collapsible read-only cards for one assistant turn in the Admin
 * Chat Transcripts dialog. Every card renders a single-line summary by
 * default; clicking opens a full-size page viewer (for course materials with
 * presigned pages) or expands inline to show full diagnostic options, practice
 * question choices/key, or simulation guide + preview launch.
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
      className="mt-2 space-y-1.5 border-t border-border/60 pt-2"
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
