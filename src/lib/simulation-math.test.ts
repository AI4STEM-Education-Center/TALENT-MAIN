import { describe, expect, it } from "vitest";
import {
  extractSimulationLatexMarkers,
  locateSimulationLatexMarkers,
  renderSimulationLatex,
  validateSimulationLatex,
} from "./simulation-math";

describe("simulation LaTeX rendering", () => {
  it("extracts inline and block markers", () => {
    const html = [
      '<span class="sim-latex" data-display="inline">F=ma</span>',
      '<span class="formula sim-latex" data-display="block">a=\\frac{F}{m}</span>',
    ].join("");

    expect(extractSimulationLatexMarkers(html)).toEqual([
      { source: "F=ma", display: "inline" },
      { source: "a=\\frac{F}{m}", display: "block" },
    ]);
  });

  it("renders valid LaTeX to self-contained MathML", () => {
    const rendered = renderSimulationLatex(
      '<p><span class="sim-latex" data-display="block">T=2\\pi\\sqrt{\\frac{L}{g}}</span></p>',
    );

    expect(rendered).toContain("<math");
    expect(rendered).toContain("application/x-tex");
    expect(rendered).toContain("T=2\\pi\\sqrt{\\frac{L}{g}}");
    expect(rendered).not.toContain("sim-latex");
    expect(rendered).not.toContain("<script");
  });

  it("validates marker shape, count, and LaTeX syntax", () => {
    expect(validateSimulationLatex("<p>No formulas</p>")).toContain(
      "document must display its formulas with at least one sim-latex marker",
    );
    expect(
      validateSimulationLatex(
        '<span class="sim-latex" data-display="wide">F=ma</span>',
      ).join(" "),
    ).toMatch(/every sim-latex marker/);
    expect(
      validateSimulationLatex(
        '<span class="sim-latex" data-display="inline">\\notARealCommand{x}</span>',
      ).join(" "),
    ).toMatch(/invalid LaTeX formula/);
  });

  it("leaves ordinary spans unchanged and safely falls back for invalid legacy markers", () => {
    expect(renderSimulationLatex('<span class="label">F = ma</span>')).toBe(
      '<span class="label">F = ma</span>',
    );
    expect(
      renderSimulationLatex(
        '<span class="sim-latex" data-display="inline">\\notARealCommand{&lt;x&gt;}</span>',
      ),
    ).toContain('<span class="sim-formula-error">');
  });

  it("keeps the LaTeX source on each formula when annotating a staff preview", () => {
    const doc =
      '<span class="sim-latex" data-display="block">F_s = -kx</span>' +
      '<span class="sim-latex" data-display="inline">v &lt; c</span>';
    const plain = renderSimulationLatex(doc);
    expect(plain).not.toContain("data-sim-latex");

    const annotated = renderSimulationLatex(doc, { annotate: true });
    // The index must line up with locateSimulationLatexMarkers, which is what
    // the equation editor addresses formulas by.
    expect(annotated).toContain(
      '<span class="sim-formula" data-sim-index="0" data-sim-display="block" data-sim-latex="F_s = -kx">',
    );
    expect(annotated).toContain('data-sim-index="1"');
    // The attribute round-trips an encoded source without re-opening the tag.
    expect(annotated).toContain('data-sim-latex="v &lt; c"');
    expect(locateSimulationLatexMarkers(doc).map((m) => m.source)).toEqual([
      "F_s = -kx",
      "v < c",
    ]);
  });
});
