import {
  MATH_DELIMITER_RULE,
  STUDENT_ANSWER_FEEDBACK_RULES,
} from "../feedback-rules";
import { coachActionRefSchema } from "../coach";
import { z } from "zod";
import {
  findStudyCandidates,
  hydrateStudyAction,
  studyActionRefSchema,
} from "../study-recommendations";
import type { AssistantSkill, AssistantToolContext } from "../types";

function requireStudent(ctx: AssistantToolContext) {
  if (ctx.audience !== "student" || !ctx.studentId)
    throw new Error("Only available to students.");
  return ctx.studentId;
}

const [materialRef, simulationRef, practiceRef] = coachActionRefSchema.options;
const studyRecommendationInput = studyActionRefSchema.extend({
  ref: z.discriminatedUnion("kind", [
    materialRef.omit({ cardId: true, interaction: true }),
    simulationRef.omit({ cardId: true, interaction: true }),
    practiceRef.omit({ cardId: true, interaction: true, questionText: true }),
  ]),
});

export const studentStudyRecommendationsSkill: AssistantSkill = {
  id: "student-study-recommendations",
  audience: "student",
  name: "Study recommendations",
  description:
    "Find and offer course materials, simulations and published practice questions, ranked by knowledge gaps.",
  instructions: [
    STUDENT_ANSWER_FEEDBACK_RULES,
    MATH_DELIMITER_RULE,
    "When asked what to study, when a student mentions a weak topic, or after reviewing a result, proactively offer ONE fitting study card.",
    "Call find_study_recommendations (optionally with a topic), then show_study_recommendation with one returned action. Candidates are ranked by unknown concepts, then recency.",
    "Keep source ids unchanged. Replace the reason with a short explanation of why it helps. For a simulation, write a goal, concrete steps and what to observe using only its description; never invent controls.",
    "Before an inline practice attempt, do not invent its content or reveal a key. After it, use the recorded question, response, and verdict to give direct feedback. If no card fits, teach the concept.",
  ].join("\n"),
  tools: [
    {
      name: "find_study_recommendations",
      activityLabel: "Finding study options",
      description:
        "Find accessible study materials, simulations and published practice for your recent mistakes, ranked by knowledge gaps. Returns safe action references, never answers.",
      input: z.object({ topic: z.string().trim().max(160).optional() }),
      handler: async (args, ctx) =>
        findStudyCandidates(
          requireStudent(ctx),
          (args as { topic?: string }).topic,
        ),
    },
    {
      name: "show_study_recommendation",
      activityLabel: "Preparing a study card",
      description:
        "Show ONE card using an action from find_study_recommendations. Every selection is checked against the student's current access. Never put answers in card text.",
      input: studyRecommendationInput,
      surfacesActions: true,
      handler: async (args, ctx) => {
        const ref = studyRecommendationInput.parse(args);
        const view = await hydrateStudyAction(ref, requireStudent(ctx));
        return view
          ? {
              ok: true,
              shown: "Showed one study card to the student.",
              action: { stored: ref, view },
            }
          : {
              ok: false,
              error: "That study option is not available right now.",
            };
      },
    },
  ],
};
