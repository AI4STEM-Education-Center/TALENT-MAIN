import { describe, it, expect } from "vitest";
import { listSkills, resolveSkills, skillInfo } from "./index";

describe("skill registry", () => {
  it("registers at least one skill per audience", () => {
    expect(listSkills("student").length).toBeGreaterThan(0);
    expect(listSkills("teacher").length).toBeGreaterThan(0);
  });

  it("never returns a skill registered for the other audience", () => {
    for (const skill of listSkills("student")) expect(skill.audience).toBe("student");
    for (const skill of listSkills("teacher")) expect(skill.audience).toBe("teacher");
  });

  it("gives every tool a unique name across the whole registry", () => {
    const names = [...listSkills("student"), ...listSkills("teacher")].flatMap((skill) =>
      skill.tools.map((tool) => tool.name)
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every tool a description and an activity label the UI can show", () => {
    for (const audience of ["student", "teacher"] as const) {
      for (const skill of listSkills(audience)) {
        for (const tool of skill.tools) {
          expect(tool.description.length).toBeGreaterThan(20);
          expect(tool.activityLabel.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("resolveSkills", () => {
  it("loads the enabled skills and unions their tools", () => {
    const ids = listSkills("student").map((skill) => skill.id);
    const { skills, tools } = resolveSkills("student", ids);
    expect(skills.map((s) => s.id)).toEqual(ids);
    expect(tools.size).toBe(skills.reduce((sum, skill) => sum + skill.tools.length, 0));
  });

  it("loads nothing when no skill is enabled", () => {
    const { skills, tools } = resolveSkills("student", []);
    expect(skills).toEqual([]);
    expect(tools.size).toBe(0);
  });

  it("ignores a skill id that is no longer registered", () => {
    const { skills } = resolveSkills("student", ["deleted-skill"]);
    expect(skills).toEqual([]);
  });

  it("refuses to load a teacher skill under the student audience", () => {
    const teacherIds = listSkills("teacher").map((skill) => skill.id);
    const { skills, tools } = resolveSkills("student", teacherIds);
    expect(skills).toEqual([]);
    expect(tools.size).toBe(0);
  });
});

describe("skillInfo", () => {
  it("exposes the tool names for the admin picker", () => {
    const info = skillInfo("teacher");
    expect(info.length).toBeGreaterThan(0);
    expect(info[0].toolNames.length).toBeGreaterThan(0);
  });
});
