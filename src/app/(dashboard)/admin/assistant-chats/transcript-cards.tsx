import { Atom, BookOpen, Dumbbell, MessageSquareMore } from "lucide-react";
import { MathText } from "@/components/ui/math-text";
import { cn } from "@/lib/utils";
import type { CoachActionRef } from "@/lib/assistant/coach-types";
import { readCardRef } from "./transcript-card-ref";

const KIND_LABEL: Record<CoachActionRef["kind"], string> = {
  material: "Course material",
  simulation: "Simulation guide",
  practice: "Practice question",
  diagnostic_options: "Diagnostic options",
};

const KIND_ICON = {
  material: BookOpen,
  simulation: Atom,
  practice: Dumbbell,
  diagnostic_options: MessageSquareMore,
} as const;

function Tag({
  tone,
  children,
}: {
  tone: "good" | "bad" | "info";
  children: string;
}) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-[10px] font-semibold",
        tone === "good" && "bg-green-600/10 text-green-700 dark:text-green-400",
        tone === "bad" && "bg-destructive/10 text-destructive",
        tone === "info" && "bg-primary/10 text-primary",
      )}
    >
      {children}
    </span>
  );
}

function headline(ref: CoachActionRef): string {
  switch (ref.kind) {
    case "material":
      return `Recommendation ${ref.recommendationIndex + 1}: ${ref.reason}`;
    case "simulation":
      return ref.goal;
    case "practice":
      return ref.questionText ?? ref.reason;
    case "diagnostic_options":
      return ref.prompt;
  }
}

function Outcome({ refItem }: { refItem: CoachActionRef }) {
  switch (refItem.kind) {
    case "material":
      return refItem.interaction ? <Tag tone="info">Viewed</Tag> : null;
    case "simulation":
      return refItem.interaction ? <Tag tone="info">Opened</Tag> : null;
    case "practice":
      return refItem.interaction ? (
        <>
          <span className="truncate text-muted-foreground">
            <MathText text={`Answered “${refItem.interaction.selectedText}”`} />
          </span>
          <Tag tone={refItem.interaction.correct ? "good" : "bad"}>
            {refItem.interaction.correct ? "Correct" : "Incorrect"}
          </Tag>
        </>
      ) : null;
    case "diagnostic_options":
      return refItem.interaction ? (
        <>
          <span className="truncate text-muted-foreground">
            <MathText
              text={`Selected “${refItem.interaction.selectedLabel}”`}
            />
          </span>
          <Tag tone="info">Chosen</Tag>
        </>
      ) : null;
  }
}

/** Compact, read-only list of the cards stored with one assistant turn. */
export function TranscriptCards({ actions }: { actions: unknown[] }) {
  const refs = actions.flatMap((raw) => {
    const ref = readCardRef(raw);
    return ref ? [ref] : [];
  });
  if (refs.length === 0) return null;
  return (
    <ul
      aria-label="Cards shown with this reply"
      className="mt-2 space-y-1 border-t border-border/60 pt-2"
    >
      {refs.map((ref, index) => {
        const Icon = KIND_ICON[ref.kind];
        return (
          <li
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- read-only stored list, never reordered; refs may lack a cardId
            key={ref.cardId ?? `${ref.kind}-${index}`}
            className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-xs"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <Icon className="size-3.5 text-primary" aria-hidden />
              {KIND_LABEL[ref.kind]}
            </p>
            <p className="mt-0.5 line-clamp-2 text-muted-foreground">
              <MathText text={headline(ref)} />
            </p>
            {ref.kind === "diagnostic_options" && (
              <p className="mt-0.5 text-muted-foreground">
                <MathText
                  text={`Options: ${ref.options.map((o) => o.label).join(" · ")}`}
                />
              </p>
            )}
            <div className="mt-1 flex min-w-0 items-center gap-1.5 empty:hidden">
              <Outcome refItem={ref} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
