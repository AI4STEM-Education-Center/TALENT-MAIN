import { describe, it, expect } from "vitest";
import {
  buildTriagePrompt,
  buildSimulationHtmlPrompt,
  buildRevisionPrompt,
  buildRevisionReviewPrompt,
  buildRevisionCorrectionPrompt,
  buildRepairPrompt,
  validateTriagePlan,
  validateRevisionReview,
  extractHtmlDocument,
  validateSimulationHtml,
  MAX_SIMULATION_HTML_BYTES,
  SIMULATION_TRIAGE_SCHEMA,
  type SimulationQuestionInput,
} from "./simulation";
import { buildSimulationKey } from "./storage";

const QUESTION: SimulationQuestionInput = {
  text: "A 3 kg block slides down a 30° incline. What is its acceleration?",
  answerMode: "SINGLE_SELECT",
  options: [{ text: "$4.9\\ m/s^2$" }, { text: "$9.8\\ m/s^2$" }],
  figureAlt: "block on an inclined plane",
  quizName: "Forces Quiz 2",
  topicName: "Newton's Laws",
};

const VALID_HTML = `<!doctype html>
<html>
<head><style>body { margin: 0; }</style></head>
<body>
<h1>Inclined plane</h1>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>
<canvas id="c"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
function frame() { requestAnimationFrame(frame); }
frame();
</script>
</body>
</html>`;

describe("buildTriagePrompt", () => {
  it("includes the question, options, figure alt, and quiz context", () => {
    const prompt = buildTriagePrompt(QUESTION, []);
    expect(prompt).toContain(QUESTION.text);
    expect(prompt).toContain("$4.9\\ m/s^2$");
    expect(prompt).toContain("block on an inclined plane");
    expect(prompt).toContain("Forces Quiz 2");
    expect(prompt).toContain("Newton's Laws");
  });

  it("states the privacy rule and the three outcomes", () => {
    const prompt = buildTriagePrompt(QUESTION, []);
    expect(prompt).toContain("THE PRIVACY RULE");
    expect(prompt).toContain("DECLINE (helpful=false)");
    expect(prompt).toContain("DUPLICATE (helpful=true, duplicate_of set)");
    expect(prompt).toContain("BUILD (helpful=true, duplicate_of=null)");
  });

  it("lists sibling simulations with 1-based indices", () => {
    const prompt = buildTriagePrompt(QUESTION, [
      { topic: "projectile motion", title: "Launch a ball" },
      { topic: "friction", title: "Sliding block" },
    ]);
    expect(prompt).toContain("1. topic: projectile motion — title: Launch a ball");
    expect(prompt).toContain("2. topic: friction — title: Sliding block");
  });

  it("marks a numeric question as having no options", () => {
    const prompt = buildTriagePrompt({ ...QUESTION, options: [], answerMode: "NUMERIC" }, []);
    expect(prompt).toContain("free-response numeric question");
  });

  it("is deterministic", () => {
    expect(buildTriagePrompt(QUESTION, [])).toBe(buildTriagePrompt(QUESTION, []));
  });
});

describe("SIMULATION_TRIAGE_SCHEMA", () => {
  it("is strict and requires every property", () => {
    expect(SIMULATION_TRIAGE_SCHEMA.strict).toBe(true);
    expect(SIMULATION_TRIAGE_SCHEMA.schema.additionalProperties).toBe(false);
    expect([...SIMULATION_TRIAGE_SCHEMA.schema.required].sort()).toEqual(
      [...Object.keys(SIMULATION_TRIAGE_SCHEMA.schema.properties)].sort()
    );
  });
});

describe("validateTriagePlan", () => {
  const nulls = { refusal_reason: null, duplicate_of: null, topic: null, title: null, learning_goal: null, spec: null };

  it("accepts a decline with a reason", () => {
    const plan = validateTriagePlan(
      { helpful: false, ...nulls, refusal_reason: "pure definition recall" },
      0
    );
    expect(plan).toEqual({ helpful: false, refusalReason: "pure definition recall" });
  });

  it("falls back to a default reason on a bare decline", () => {
    const plan = validateTriagePlan({ helpful: false, ...nulls }, 0);
    expect(plan.helpful).toBe(false);
    if (!plan.helpful) expect(plan.refusalReason).toContain("declined");
  });

  it("accepts a build plan with all fields", () => {
    const plan = validateTriagePlan(
      {
        helpful: true,
        ...nulls,
        topic: "inclined planes",
        title: "Forces on a slope",
        learning_goal: "See how angle changes acceleration",
        spec: "Canvas with a block on an adjustable slope...",
      },
      0
    );
    expect(plan).toEqual({
      helpful: true,
      duplicateOfIndex: null,
      topic: "inclined planes",
      title: "Forces on a slope",
      learningGoal: "See how angle changes acceleration",
      spec: "Canvas with a block on an adjustable slope...",
    });
  });

  it("maps a 1-based duplicate_of into a 0-based index", () => {
    const plan = validateTriagePlan({ helpful: true, ...nulls, duplicate_of: 2 }, 3);
    expect(plan.helpful).toBe(true);
    if (plan.helpful) expect(plan.duplicateOfIndex).toBe(1);
  });

  it("treats an out-of-range duplicate_of as a build (and then requires the fields)", () => {
    expect(() => validateTriagePlan({ helpful: true, ...nulls, duplicate_of: 5 }, 2)).toThrow(/topic/);
  });

  it("throws on missing build fields", () => {
    expect(() =>
      validateTriagePlan({ helpful: true, ...nulls, topic: "x", title: "y", learning_goal: "z" }, 0)
    ).toThrow(/spec/);
  });

  it("throws on a non-object payload and a non-boolean helpful", () => {
    expect(() => validateTriagePlan(null, 0)).toThrow(/object/);
    expect(() => validateTriagePlan({ helpful: "yes", ...nulls }, 0)).toThrow(/boolean/);
  });
});

describe("extractHtmlDocument", () => {
  it("passes a bare document through", () => {
    expect(extractHtmlDocument(VALID_HTML)).toBe(VALID_HTML);
  });

  it("strips markdown fences and commentary", () => {
    const wrapped = "Here is the simulation:\n```html\n" + VALID_HTML + "\n```\nLet me know!";
    expect(extractHtmlDocument(wrapped)).toBe(VALID_HTML);
  });

  it("returns trimmed text when no document markers exist", () => {
    expect(extractHtmlDocument("  no html here  ")).toBe("no html here");
  });
});

describe("validateSimulationHtml", () => {
  it("accepts a valid self-contained document (SVG xmlns included)", () => {
    expect(validateSimulationHtml(VALID_HTML)).toEqual([]);
  });

  it("rejects an empty document", () => {
    expect(validateSimulationHtml("   ")).toEqual(["document is empty"]);
  });

  it("requires the doctype/closing tag and a script", () => {
    const problems = validateSimulationHtml("<div>hi</div>");
    expect(problems.join(" ")).toMatch(/doctype/);
    expect(problems.join(" ")).toMatch(/<\/html>/);
    expect(problems.join(" ")).toMatch(/script/);
  });

  it("rejects external src/href references", () => {
    const doc = VALID_HTML.replace(
      "<canvas id=\"c\"></canvas>",
      '<img src="https://evil.example/x.png"><canvas id="c"></canvas>'
    );
    expect(validateSimulationHtml(doc).join(" ")).toMatch(/external URL/);
  });

  it("rejects protocol-relative references", () => {
    const doc = VALID_HTML.replace(
      "<canvas id=\"c\"></canvas>",
      '<script src="//cdn.example/lib.js"></script><canvas id="c"></canvas>'
    );
    expect(validateSimulationHtml(doc).join(" ")).toMatch(/external URL/);
  });

  it("rejects forbidden elements", () => {
    const doc = VALID_HTML.replace("<canvas", '<iframe src="x"></iframe><canvas');
    expect(validateSimulationHtml(doc).join(" ")).toMatch(/forbidden element <iframe>/);
  });

  it("rejects network APIs", () => {
    const doc = VALID_HTML.replace("frame();", 'fetch("/api/steal");frame();');
    expect(validateSimulationHtml(doc).join(" ")).toMatch(/network API/);
  });

  it("rejects external CSS url() and @import", () => {
    const withUrl = VALID_HTML.replace("margin: 0;", "background: url(https://x.example/bg.png);");
    expect(validateSimulationHtml(withUrl).join(" ")).toMatch(/CSS url\(\)/);
    const withImport = VALID_HTML.replace("margin: 0;", '@import "other.css";');
    expect(validateSimulationHtml(withImport).join(" ")).toMatch(/@import/);
  });

  it("allows data: URIs", () => {
    const doc = VALID_HTML.replace(
      "<canvas id=\"c\"></canvas>",
      '<img src="data:image/png;base64,AAAA"><canvas id="c"></canvas>'
    );
    expect(validateSimulationHtml(doc)).toEqual([]);
  });

  it("rejects oversized documents", () => {
    const doc = VALID_HTML.replace("<h1>Inclined plane</h1>", "<h1>" + "x".repeat(MAX_SIMULATION_HTML_BYTES) + "</h1>");
    expect(validateSimulationHtml(doc).join(" ")).toMatch(/exceeds/);
  });
});

describe("build/revision/repair prompts", () => {
  const plan = {
    topic: "inclined planes",
    title: "Forces on a slope",
    learningGoal: "See how angle changes acceleration",
    spec: "Canvas with a block on an adjustable slope.",
  };

  it("the build prompt carries the plan and the hard requirements, never the question", () => {
    const prompt = buildSimulationHtmlPrompt(plan);
    expect(prompt).toContain(plan.spec);
    expect(prompt).toContain("HARD REQUIREMENTS");
    expect(prompt).toContain("sandboxed iframe");
    expect(prompt).not.toContain(QUESTION.text);
  });

  it("the revision prompt carries the current document, prior and new feedback", () => {
    const prompt = buildRevisionPrompt(plan, VALID_HTML, ["fix the axis labels"], "period formula is wrong");
    expect(prompt).toContain(VALID_HTML);
    expect(prompt).toContain("1. fix the axis labels");
    expect(prompt).toContain("period formula is wrong");
    expect(prompt).toContain("HARD REQUIREMENTS");
  });

  it("the repair prompt lists every problem", () => {
    const prompt = buildRepairPrompt(["document has no <script>", "forbidden element <iframe>"]);
    expect(prompt).toContain("- document has no <script>");
    expect(prompt).toContain("- forbidden element <iframe>");
  });

  it("the revision-review prompt carries the revised document, both feedbacks, and every check", () => {
    const prompt = buildRevisionReviewPrompt(plan, VALID_HTML, ["fix the axis labels"], "period formula is wrong");
    expect(prompt).toContain(VALID_HTML);
    expect(prompt).toContain("1. fix the axis labels");
    expect(prompt).toContain("period formula is wrong");
    expect(prompt).toContain("feedback_applied");
    expect(prompt).toContain("physics_intact");
    expect(prompt).toContain("layout_intact");
    expect(prompt).toContain("simulation_works");
    expect(prompt).not.toContain(QUESTION.text);
  });

  it("the correction prompt lists the review's problems and re-states the feedback", () => {
    const prompt = buildRevisionCorrectionPrompt(VALID_HTML, "period formula is wrong", [
      "the period ignores L",
      "the reset button is dead",
    ]);
    expect(prompt).toContain(VALID_HTML);
    expect(prompt).toContain("period formula is wrong");
    expect(prompt).toContain("- the period ignores L");
    expect(prompt).toContain("- the reset button is dead");
    expect(prompt).toContain("HARD REQUIREMENTS");
  });
});

describe("validateRevisionReview", () => {
  const allTrue = {
    feedback_applied: true,
    physics_intact: true,
    layout_intact: true,
    simulation_works: true,
    ok: true,
    problems: [],
  };

  it("passes only when the verdict and every sub-check are true", () => {
    expect(validateRevisionReview(allTrue)).toEqual({ ok: true, problems: [] });
  });

  it("fails (with the model's problems) when ok is false", () => {
    const review = validateRevisionReview({
      ...allTrue,
      ok: false,
      physics_intact: false,
      problems: ["the period formula ignores L"],
    });
    expect(review.ok).toBe(false);
    expect(review.problems).toContain("the period formula ignores L");
  });

  it("treats a failed sub-check as a failure even when ok is true", () => {
    const review = validateRevisionReview({ ...allTrue, layout_intact: false, ok: true });
    expect(review.ok).toBe(false);
    // With no explicit problems, it synthesizes one from the failed check.
    expect(review.problems.length).toBeGreaterThan(0);
  });

  it("always yields at least one problem when failing", () => {
    const review = validateRevisionReview({ ...allTrue, ok: false, problems: [] });
    expect(review.ok).toBe(false);
    expect(review.problems.length).toBeGreaterThan(0);
  });

  it("throws on a non-object payload", () => {
    expect(() => validateRevisionReview(null)).toThrow(/object/);
  });
});

describe("buildSimulationKey", () => {
  it("scopes pool questions under pool/ and versions the file", () => {
    expect(buildSimulationKey(null, "quiz1", "q1", 1)).toBe("simulations/pool/quiz1/q1/v1.html");
  });

  it("scopes teacher questions under the teacher id", () => {
    expect(buildSimulationKey("t42", "quiz1", "q1", 3)).toBe("simulations/t42/quiz1/q1/v3.html");
  });
});
