import { describe, expect, it } from "vitest";
import {
  createSimulationReplyStream,
  parseSimulationEditPlan,
  splitSimulationReply,
} from "./simulation-edit";

const TAIL = {
  name: "Explore speed",
  questions: [],
  revisionPrompt: "Rename the title and remove the timer.",
};
const reply = (prose: string, tail: unknown = TAIL) =>
  `${prose}\n\n\`\`\`json\n${JSON.stringify(tail)}\n\`\`\``;

/** Feed a reply through the splitter the way a provider delivers it. */
function stream(deltas: string[]): string {
  const splitter = createSimulationReplyStream();
  return deltas.map((delta) => splitter.push(delta)).join("");
}

describe("streaming the prose half", () => {
  it("hands out the prose and never the JSON block", () => {
    const full = reply("I can rename the title.");
    expect(stream([...full])).toBe("I can rename the title.\n\n");
  });

  it("holds back backticks that might still become a fence", () => {
    const splitter = createSimulationReplyStream();
    expect(splitter.push("Ready.\n\n")).toBe("Ready.\n\n");
    // Two of the three have arrived — emitting now would flash a stray ``.
    expect(splitter.push("``")).toBe("");
    expect(splitter.push("`json\n{}")).toBe("");
  });

  it("releases backticks that turn out to be prose", () => {
    const splitter = createSimulationReplyStream();
    expect(splitter.push("Use the `")).toBe("Use the ");
    expect(splitter.push("reset` button.")).toBe("`reset` button.");
  });

  it("does not re-send prose when a delta splits mid-word", () => {
    expect(stream(["Remo", "ving the ti", "mer.", "\n```json\n{}\n```"])).toBe(
      "Removing the timer.\n",
    );
  });
});

describe("splitting a finished reply", () => {
  it("takes the last fenced block, so a tool round's narration cannot win", () => {
    const raw = `Checking the plan.\n\n\`\`\`json\n{"draft":true}\n\`\`\`\n\nHere is the plan.\n\n${"```json"}\n${JSON.stringify(TAIL)}\n\`\`\``;
    const { prose, json } = splitSimulationReply(raw);
    expect(JSON.parse(json!)).toMatchObject({ name: "Explore speed" });
    expect(prose).toContain("Here is the plan.");
  });

  it("reads an unfenced object, and the whole reply when it is one", () => {
    expect(splitSimulationReply(JSON.stringify(TAIL))).toMatchObject({
      prose: "",
    });
    expect(
      JSON.parse(splitSimulationReply(`Ready.\n${JSON.stringify(TAIL)}`).json!),
    ).toMatchObject({ name: "Explore speed" });
  });

  it("reports a reply that carried no JSON at all", () => {
    expect(splitSimulationReply("I am not sure what you mean.").json).toBeNull();
    expect(() => parseSimulationEditPlan("I am not sure.")).toThrow();
  });
});

describe("assembling the plan", () => {
  it("keeps the streamed prose as the message", () => {
    const plan = parseSimulationEditPlan(reply("I can rename the title."));
    expect(plan).toMatchObject({
      message: "I can rename the title.",
      name: "Explore speed",
      questions: [],
    });
  });

  // The contract before streaming, and what a model that ignores the new one
  // still produces. It has to keep working: the transcript is full of them.
  it("falls back to a message inside the JSON when no prose was written", () => {
    const plan = parseSimulationEditPlan(
      JSON.stringify({ ...TAIL, message: "Ready to rename." }),
    );
    expect(plan.message).toBe("Ready to rename.");
  });

  it("tolerates an omitted questions array rather than failing the turn", () => {
    const plan = parseSimulationEditPlan(
      reply("Ready.", { name: "Explore speed" }),
    );
    expect(plan).toMatchObject({ questions: [], revisionPrompt: "" });
  });

  it("rejects a reply with no name to give the branch", () => {
    expect(() =>
      parseSimulationEditPlan(reply("Ready.", { revisionPrompt: "Do it." })),
    ).toThrow();
  });
});
