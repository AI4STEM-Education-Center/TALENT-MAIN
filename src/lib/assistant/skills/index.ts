// The skill registry — the assistant's whole capability surface.
//
// A skill is a declarative bundle: prompt instructions + a fixed list of tools
// whose handlers are ordinary, hand-written TypeScript. That is the deliberate
// alternative to giving the agent a shell or an eval tool: the assistant can
// only do what a tool in this file's registry lets it do, every argument is
// validated by the tool's zod schema, and every query is scoped to the caller's
// own rows. There is no path from a model response to arbitrary code or SQL.
//
// The shape (id, name, description, tool list) mirrors an MCP server's
// capability set on purpose: moving a skill behind an MCP transport later is a
// change to how `resolveSkills` loads it, not a change to any tool.
//
// To add a skill: write it in this directory and add it to REGISTRY. It shows up
// in the admin panel for its audience on the next request.

import type { AssistantAudience, AssistantSkill, AssistantTool } from "../types";
import { studentQuizResultsSkill } from "./student-quiz-results";
import { teacherClassInsightsSkill } from "./teacher-class-insights";

const REGISTRY: AssistantSkill[] = [studentQuizResultsSkill, teacherClassInsightsSkill];

/** Every skill registered for an audience, in registry order. */
export function listSkills(audience: AssistantAudience): AssistantSkill[] {
  return REGISTRY.filter((skill) => skill.audience === audience);
}

/** UI-safe descriptor for the admin skill picker. */
export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  toolNames: string[];
};

export function skillInfo(audience: AssistantAudience): SkillInfo[] {
  return listSkills(audience).map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    toolNames: skill.tools.map((tool) => tool.name),
  }));
}

export type ResolvedSkills = {
  skills: AssistantSkill[];
  /** The union of the loaded skills' tools, keyed by tool name. */
  tools: Map<string, AssistantTool>;
};

/**
 * Load the skills an audience has enabled. Ids are filtered against the
 * registry for the audience, so a stale id in the DB — or a teacher skill id
 * saved under the student row — loads nothing rather than crossing audiences.
 *
 * A duplicate tool name across two skills would make dispatch ambiguous, so the
 * first registered skill wins and the collision is logged; this is a
 * programming error, not a runtime condition, and it must not take chat down.
 */
export function resolveSkills(
  audience: AssistantAudience,
  enabledIds: string[]
): ResolvedSkills {
  const wanted = new Set(enabledIds);
  const skills = listSkills(audience).filter((skill) => wanted.has(skill.id));
  const tools = new Map<string, AssistantTool>();
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (tools.has(tool.name)) {
        console.error(
          `[Assistant] Duplicate tool name "${tool.name}" from skill "${skill.id}"; keeping the first.`
        );
        continue;
      }
      tools.set(tool.name, tool);
    }
  }
  return { skills, tools };
}
