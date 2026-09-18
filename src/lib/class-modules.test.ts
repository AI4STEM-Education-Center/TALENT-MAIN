import { describe, expect, it } from "vitest";
import { groupModuleQuizzes, moveModuleQuizzes } from "./class-modules";
const modules = [
  {
    id: "midterm",
    name: "Midterm",
    description: "Review",
    quizIds: ["q1", "q2", "q3"],
  },
  { id: "final", name: "Final", description: "", quizIds: ["q1", "q4"] },
];
describe("module organization", () => {
  it("moves a selection without duplicating destination quizzes or removing other reuse", () => {
    const moved = moveModuleQuizzes(
      modules,
      ["q1", "q2"],
      "midterm",
      "final",
      "q4",
    );
    expect(moved.map((m) => m.quizIds)).toEqual([["q3"], ["q1", "q2", "q4"]]);
    expect(modules[0].quizIds).toEqual(["q1", "q2", "q3"]);
  });
  it("adds to another module while preserving the original membership", () => {
    expect(
      moveModuleQuizzes(modules, ["q2"], null, "final").map((m) => m.quizIds),
    ).toEqual([
      ["q1", "q2", "q3"],
      ["q1", "q4", "q2"],
    ]);
  });
  it("reorders within a module and removes only the selected membership", () => {
    expect(
      moveModuleQuizzes(modules, ["q3"], "midterm", "midterm", "q1")[0].quizIds,
    ).toEqual(["q3", "q1", "q2"]);
    expect(
      moveModuleQuizzes(modules, ["q1"], "midterm", null).map((m) => m.quizIds),
    ).toEqual([
      ["q2", "q3"],
      ["q1", "q4"],
    ]);
  });
  it("student groups exclude unpublished quizzes and empty modules and retain shared progress objects", () => {
    const published = [
      { id: "q1", status: "COMPLETED" },
      { id: "q5", status: "NOT_STARTED" },
    ];
    const groups = groupModuleQuizzes(
      [
        ...modules,
        { id: "draft", name: "Hidden", description: "", quizIds: ["q6"] },
      ],
      published,
    );
    expect(groups.map((g) => g.name)).toEqual([
      "Midterm",
      "Final",
      "Other quizzes",
    ]);
    expect(groups[0].quizzes[0]).toBe(published[0]);
    expect(groups[1].quizzes[0]).toBe(published[0]);
    expect(groups[2].quizzes).toEqual([published[1]]);
  });
});
