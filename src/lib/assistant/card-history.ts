import { fenceUntrusted } from "@/lib/guardrail-fence";
import { coachActionRefSchema } from "./coach";
import { studyActionRefSchema } from "./study-recommendations";
import type { AssistantTurn } from "./types";

export function formatCardHistory(actions: unknown[] | undefined): string {
  const lines = (actions ?? []).flatMap((action) => {
    const study = studyActionRefSchema.safeParse(action);
    const parsed = study.success
      ? { success: true as const, data: study.data.ref }
      : coachActionRefSchema.safeParse(action);
    if (!parsed.success) return [];
    const ref = parsed.data;
    switch (ref.kind) {
      case "material":
        return [
          `Material recommendation ${ref.recommendationIndex + 1}: ${ref.reason}${ref.interaction ? ` | Viewed${ref.interaction.summary ? `: ${ref.interaction.summary}` : ""}` : ""}`,
        ];
      case "simulation":
        return [
          `Simulation ${ref.simulationId}: ${ref.goal}${ref.interaction ? ` | Opened${ref.interaction.summary ? `: ${ref.interaction.summary}` : ""}` : ""}`,
        ];
      case "practice":
        return [
          ref.interaction
            ? `Practice question: ${ref.questionText ?? ref.variantQuestionId} | Student answered: ${ref.interaction.selectedText} | Result: ${ref.interaction.correct ? "right" : "wrong"}`
            : `Practice question ${ref.variantQuestionId} shown: ${ref.reason}`,
        ];
      case "diagnostic_options":
        return [
          `Diagnostic options: ${ref.prompt} ${ref.options.map((option) => option.label).join(" / ")}${ref.interaction ? ` | Student selected: ${ref.interaction.selectedLabel}` : ""}`,
        ];
    }
  });
  return lines.length
    ? fenceUntrusted("recorded card activity", lines.join("\n"))
    : "";
}

export function completedCoachPractice(turns: AssistantTurn[]) {
  return turns.flatMap((turn) =>
    turn.role === "assistant"
      ? (turn.actions ?? []).flatMap((action) => {
          const parsed = coachActionRefSchema.safeParse(action);
          return parsed.success &&
            parsed.data.kind === "practice" &&
            parsed.data.interaction
            ? [
                {
                  ...parsed.data.interaction,
                  questionText: parsed.data.questionText,
                },
              ]
            : [];
        })
      : [],
  );
}
