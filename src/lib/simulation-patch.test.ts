import { describe, expect, it } from "vitest";
import {
  applySimulationPatches,
  describeSimulationPatch,
  listSimulationFormulas,
  type SimulationPatch,
} from "./simulation-patch";
import { validateSimulationHtml } from "./simulation";

/**
 * Shaped like what the generator prompt asks for: one style, one visual stage,
 * one inline script, four wired controls, and a formula section of one card per
 * relationship. Direct edits have to leave all of that intact.
 */
const DOC = `<!doctype html>
<html>
<head><style>body { margin: 0; }</style></head>
<body>
<h1>Spring lab</h1>
<p>Here <b>x</b> is the displacement in metres.</p>
<p class="hint">Stiffness sets how hard the spring pulls back.</p>
<div class="cards">
<div class="card"><span class="sim-latex" data-display="block">F_s = -kx</span></div>
<div class="card"><span class="sim-latex" data-display="block">U_s = \\frac{1}{2}kx^2</span></div>
</div>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>
<label>Stiffness <input id="k" type="range" min="1" max="90" value="30"></label>
<label>Mass <input id="mass" type="range" min="1" max="20" value="5"></label>
<label>Damping <input id="damping" type="range" min="0" max="20" value="1"></label>
<label>Start <input id="start" type="range" min="0" max="1" value="0.3"></label>
<script>
const k = document.getElementById("k");
const mass = document.getElementById("mass");
const damping = document.getElementById("damping");
const start = document.getElementById("start");
function draw() { [k, mass, damping, start].map((input) => Number(input.value)); }
k.addEventListener("input", draw);
mass.addEventListener("input", draw);
damping.addEventListener("input", draw);
start.addEventListener("input", draw);
draw();
</script>
</body>
</html>`;

function apply(...patches: SimulationPatch[]) {
  return applySimulationPatches(DOC, patches);
}
function html(...patches: SimulationPatch[]) {
  const result = apply(...patches);
  if (!result.ok) throw new Error(result.problem);
  return result.html;
}

describe("listSimulationFormulas", () => {
  it("numbers the formulas in the order they appear on screen", () => {
    expect(listSimulationFormulas(DOC)).toEqual([
      { index: 0, latex: "F_s = -kx", display: "block" },
      { index: 1, latex: "U_s = \\frac{1}{2}kx^2", display: "block" },
    ]);
  });
});

describe("formula edits", () => {
  it("rewrites one formula and leaves its neighbour and the document valid", () => {
    const out = html({ kind: "formula-edit", index: 0, latex: "F_s = -k x^3" });
    expect(listSimulationFormulas(out)).toMatchObject([
      { latex: "F_s = -k x^3" },
      { latex: "U_s = \\frac{1}{2}kx^2" },
    ]);
    expect(validateSimulationHtml(out)).toEqual([]);
  });

  it("removes the card a formula lives in, not just the formula", () => {
    const out = html({ kind: "formula-delete", index: 0 });
    expect(listSimulationFormulas(out)).toMatchObject([
      { latex: "U_s = \\frac{1}{2}kx^2" },
    ]);
    expect(out).not.toContain("F_s");
    expect(out.match(/class="card"/g)).toHaveLength(1);
    expect(validateSimulationHtml(out)).toEqual([]);
  });

  it("adds a formula into a clone of the last card", () => {
    const out = html({
      kind: "formula-add",
      latex: "E = K + U_s",
      display: "block",
    });
    expect(listSimulationFormulas(out)).toMatchObject([
      { latex: "F_s = -kx" },
      { latex: "U_s = \\frac{1}{2}kx^2" },
      { latex: "E = K + U_s", display: "block" },
    ]);
    expect(out.match(/class="card"/g)).toHaveLength(3);
    expect(validateSimulationHtml(out)).toEqual([]);
  });

  it("keeps add and delete usable in one batch", () => {
    const out = html(
      { kind: "formula-delete", index: 0 },
      { kind: "formula-add", latex: "K = \\frac{1}{2}mv^2", display: "block" },
    );
    expect(listSimulationFormulas(out)).toMatchObject([
      { latex: "U_s = \\frac{1}{2}kx^2" },
      { latex: "K = \\frac{1}{2}mv^2" },
    ]);
    expect(validateSimulationHtml(out)).toEqual([]);
  });

  it("refuses LaTeX KaTeX cannot parse, and markup that would break the marker", () => {
    expect(
      apply({ kind: "formula-edit", index: 0, latex: "\\frac{1}" }),
    ).toMatchObject({ ok: false });
    expect(
      apply({ kind: "formula-add", latex: "a <b> c", display: "inline" }),
    ).toMatchObject({ ok: false });
    expect(
      apply({ kind: "formula-edit", index: 0, latex: "$F=ma$" }),
    ).toMatchObject({ ok: false });
  });

  it("refuses to remove the last formula or to touch one twice", () => {
    expect(
      apply(
        { kind: "formula-delete", index: 0 },
        { kind: "formula-delete", index: 1 },
      ),
    ).toMatchObject({
      ok: false,
      problem: expect.stringContaining("at least one"),
    });
    expect(
      apply(
        { kind: "formula-edit", index: 0, latex: "a=b" },
        { kind: "formula-delete", index: 0 },
      ),
    ).toMatchObject({ ok: false });
    expect(apply({ kind: "formula-delete", index: 7 })).toMatchObject({
      ok: false,
    });
  });
});

describe("text edits", () => {
  it("rewrites a run of text that sits beside inline markup", () => {
    const out = html({
      kind: "text",
      before: "is the displacement in metres.",
      after: "is the displacement from equilibrium, in metres.",
    });
    expect(out).toContain(
      "<b>x</b> is the displacement from equilibrium, in metres.",
    );
    expect(validateSimulationHtml(out)).toEqual([]);
  });

  it("escapes replacement text so it cannot inject markup", () => {
    const out = html({
      kind: "text",
      before: "Spring lab",
      after: 'Spring & <script>alert("x")</script>',
    });
    expect(out).toContain("Spring &amp; &lt;script&gt;");
    expect(validateSimulationHtml(out)).toEqual([]);
  });

  it("refuses text that only exists in the simulation's code", () => {
    expect(
      apply({ kind: "text", before: "addEventListener", after: "on" }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringContaining("run time"),
    });
  });

  it("refuses ambiguous text rather than guessing which one to change", () => {
    expect(
      apply({ kind: "text", before: "Stiffness", after: "Spring constant" }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringContaining("more than once"),
    });
  });

  it("refuses an empty patch set", () => {
    expect(applySimulationPatches(DOC, [])).toMatchObject({ ok: false });
  });
});

describe("describeSimulationPatch", () => {
  it("names the formula it is about, so the chat hand-off reads sensibly", () => {
    const formulas = listSimulationFormulas(DOC);
    expect(
      describeSimulationPatch({ kind: "formula-delete", index: 1 }, formulas),
    ).toContain(JSON.stringify("U_s = \\frac{1}{2}kx^2"));
    expect(
      describeSimulationPatch(
        { kind: "text", before: "Spring lab", after: "Spring bench" },
        formulas,
      ),
    ).toBe('Replace text "Spring lab" with "Spring bench".');
  });
});
