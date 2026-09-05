import { z } from "zod";
import type { AssistantSkill } from "../types";
export const simulationEditingSkill: AssistantSkill = {
  id: "simulation-editing",
  name: "Simulation revision planning",
  audience: "simulation",
  description:
    "Review learning direction, editable text, and interactive functions before preparing a revision.",
  instructions:
    "Use review_simulation_plan to check your proposed changes for teaching and interaction concerns before finalizing the revision prompt.",
  tools: [
    {
      name: "review_simulation_plan",
      activityLabel: "Reviewing revision plan",
      description: "Check the completeness of a proposed simulation revision.",
      input: z.object({
        textChanges: z.string(),
        functionChanges: z.string(),
        learningDirection: z.string(),
        acceptanceChecks: z.array(z.string()),
      }),
      handler: async (args) => ({
        proposal: args,
        reminders: [
          "Preserve correct units and science",
          "Keep controls accessible and reset functional",
          "Never include quiz answers",
          "Confirm unresolved choices with the teacher",
        ],
      }),
    },
  ],
};
