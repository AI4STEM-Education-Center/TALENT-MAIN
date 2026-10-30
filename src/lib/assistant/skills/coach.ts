// The wrong-answer coach's tools.
//
// Deliberately NOT in the skill REGISTRY: a coach turn loads exactly this
// bundle, and the assistant widget (and the admin skill picker built from the
// registry) never sees these tools. Each tool picks something the server
// already vetted — a number from the material list, an id from the simulation
// list, the one alternative question that exists for this question — and every
// pick is re-validated and hydrated by coach.ts before it reaches the student.
//
// There is no "give advice" tool: advice is the model's ordinary prose reply.
// The tools exist only for the answers that should render as a card.

import { z } from "zod";
import {
  COACH_OBSERVE_MAX,
  COACH_REASON_MAX,
  COACH_STEPS_MAX,
  COACH_STEPS_MIN,
  COACH_STEP_MAX,
  type CoachActionRef,
} from "../coach-types";
import {
  hydrateCoachAction,
  loadCoachCandidates,
  coachActionRefSchema,
} from "../coach";
import type {
  AssistantSkill,
  AssistantTool,
  AssistantToolContext,
} from "../types";

function requireCoach(ctx: AssistantToolContext) {
  if (!ctx.coach) throw new Error("This tool is only available to the coach.");
  return ctx.coach;
}

/** Validate a reference the tool built, hydrate it, and package the result. */
async function surface(
  ctx: AssistantToolContext,
  ref: CoachActionRef,
  shown: string,
) {
  const scope = requireCoach(ctx);
  const parsed = coachActionRefSchema.safeParse(ref);
  if (!parsed.success)
    return { ok: false, error: "The details were not in a valid form." };
  const view = await hydrateCoachAction(parsed.data, scope);
  if (!view)
    return {
      ok: false,
      error: "That is not available to this student right now.",
    };
  // `action` is peeled off by the agent loop; the model only reads `shown`.
  return { ok: true, shown, action: { stored: parsed.data, view } };
}

const reasonField = z
  .string()
  .trim()
  .min(1)
  .max(COACH_REASON_MAX)
  .describe(
    "One sentence, addressed to the student, on why this helps with THEIR mistake. " +
      "Never state or hint at the correct answer.",
  );

const materialInput = z.object({
  materialNumber: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe("The number from the Materials list in the question context."),
  reason: reasonField,
});

const recommendMaterial: AssistantTool<typeof materialInput> = {
  name: "recommend_material",
  description:
    "Show the student a card for one of the course materials listed in the question context, " +
    "which they can open and read. Use it when the gap is conceptual and a specific listed " +
    "material covers it. Only numbers from the list work.",
  activityLabel: "Finding a study material",
  surfacesActions: true,
  input: materialInput,
  handler: async (args, ctx) => {
    const scope = requireCoach(ctx);
    const { materials } = await loadCoachCandidates(scope);
    const option = materials.find((m) => m.number === args.materialNumber);
    if (!option)
      return {
        ok: false,
        error: `No material numbered ${args.materialNumber}. Pick from the list, or give advice instead.`,
      };
    return surface(
      ctx,
      {
        kind: "material",
        recommendationIndex: option.recommendationIndex,
        reason: args.reason,
      },
      `Showed the student a card for "${option.title}" (${option.pages}).`,
    );
  },
};

const simulationInput = z.object({
  simulationId: z
    .string()
    .min(1)
    .max(64)
    .describe("The id from the Simulations list in the question context."),
  goal: z
    .string()
    .trim()
    .min(1)
    .max(COACH_REASON_MAX)
    .describe("What the student should be able to explain after using it."),
  steps: z
    .array(z.string().trim().min(1).max(COACH_STEP_MAX))
    .min(COACH_STEPS_MIN)
    .max(COACH_STEPS_MAX)
    .describe(
      "Concrete actions in order: which control to set or change, and to what. " +
        "Only mention controls the simulation's description says exist.",
    ),
  observe: z
    .string()
    .trim()
    .min(1)
    .max(COACH_OBSERVE_MAX)
    .describe("What to watch for as they change it, and what it tells them."),
});

const explainSimulation: AssistantTool<typeof simulationInput> = {
  name: "explain_simulation",
  description:
    "Show the student a how-to card for one of the simulations listed in the question context, " +
    "with a button that opens it. Write the steps so they run an experiment that exposes the " +
    "idea behind their mistake — what to adjust and what to observe — without handing them the " +
    "answer to the question.",
  activityLabel: "Preparing a simulation guide",
  surfacesActions: true,
  input: simulationInput,
  handler: async (args, ctx) =>
    surface(
      ctx,
      {
        kind: "simulation",
        simulationId: args.simulationId,
        goal: args.goal,
        steps: args.steps,
        observe: args.observe,
      },
      "Showed the student a simulation guide with the steps you wrote.",
    ),
};

const practiceInput = z.object({ reason: reasonField });

const offerPracticeQuestion: AssistantTool<typeof practiceInput> = {
  name: "offer_practice_question",
  description:
    "Offer the student an existing alternative-version question for this exact question, shown " +
    "inline for them to answer. Only works when the question context says one exists. You cannot " +
    "see it and must not describe or invent its content.",
  activityLabel: "Finding a practice question",
  surfacesActions: true,
  input: practiceInput,
  handler: async (args, ctx) => {
    const scope = requireCoach(ctx);
    const { practice } = await loadCoachCandidates(scope);
    if (!practice)
      return {
        ok: false,
        error:
          "No alternative-version question exists for this question. Give advice or use another option.",
      };
    return surface(
      ctx,
      {
        kind: "practice",
        versionId: practice.versionId,
        variantQuestionId: practice.variantQuestionId,
        reason: args.reason,
      },
      "Showed the student a practice question to try. They will answer it themselves.",
    );
  },
};

export const coachSkill: AssistantSkill = {
  id: "wrong-answer-coach",
  name: "Wrong-answer coach",
  description:
    "Per-question coaching: advice, a course material, a simulation how-to, or an existing practice question.",
  audience: "student",
  instructions: [
    "recommend_material shows a card for one listed course material.",
    "explain_simulation shows a how-to card (steps to run, what to observe) for one listed simulation.",
    "offer_practice_question shows an existing alternative-version question for this question.",
  ].join("\n"),
  tools: [recommendMaterial, explainSimulation, offerPracticeQuestion],
};

/** The coach's tools by name, in the shape the agent loop expects. */
export function coachTools(): Map<string, AssistantTool> {
  return new Map(coachSkill.tools.map((tool) => [tool.name, tool]));
}
