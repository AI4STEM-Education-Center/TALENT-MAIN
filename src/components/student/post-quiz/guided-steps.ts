// The guided post-quiz review as a pure step model, so the page component and
// its tests agree on which steps exist and what "next" means.

export type GuidedStepId =
  "summary" | "coach" | "simulations" | "materials" | "complete";

export const STEP_LABEL: Record<GuidedStepId, string> = {
  summary: "Summary",
  coach: "Missed questions",
  simulations: "Simulations",
  materials: "Learning materials",
  complete: "Complete",
};

/** The primary button that moves on TO a step. */
export const ADVANCE_LABEL: Record<GuidedStepId, string> = {
  summary: "Back to summary",
  coach: "Next: Review Missed Questions",
  simulations: "Continue to Simulations",
  materials: "Continue to Learning Materials",
  complete: "Finish Review",
};

export type GuidedStepInput = {
  mistakeCount: number;
  simulationCount: number;
  recommendationCount: number;
  /** True while simulations and materials are still being generated. */
  recommendationsPending: boolean;
  /**
   * The step on screen. It is always kept, so a step whose content resolves
   * empty while the student is on it explains itself instead of vanishing.
   */
  active: GuidedStepId;
};

/** The steps this attempt has, in order. Empty steps are left out. */
export function guidedSteps({
  mistakeCount,
  simulationCount,
  recommendationCount,
  recommendationsPending,
  active,
}: GuidedStepInput): GuidedStepId[] {
  const present: Record<GuidedStepId, boolean> = {
    summary: true,
    coach: mistakeCount > 0,
    simulations: simulationCount > 0 || recommendationsPending,
    materials: recommendationCount > 0 || recommendationsPending,
    complete: true,
  };
  return (Object.keys(present) as GuidedStepId[]).filter(
    (id) => present[id] || id === active,
  );
}

/** The step after `current`, or null on the last one. */
export function nextStep(
  steps: GuidedStepId[],
  current: GuidedStepId,
): GuidedStepId | null {
  const at = steps.indexOf(current);
  return at === -1 ? null : (steps[at + 1] ?? null);
}
