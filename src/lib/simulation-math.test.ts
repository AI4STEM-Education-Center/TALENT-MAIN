import { describe, expect, it } from "vitest";
import {
  extractSimulationLatexMarkers,
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
      '<p><span class="sim-latex" data-display="block">T=2\\pi\\sqrt{\\frac{L}{g}}</span></p>'
    );

    expect(rendered).toContain("<math");
    expect(rendered).toContain("application/x-tex");
    expect(rendered).toContain("T=2\\pi\\sqrt{\\frac{L}{g}}");
    expect(rendered).not.toContain("sim-latex");
    expect(rendered).not.toContain("<script");
  });

  it("validates marker shape, count, and LaTeX syntax", () => {
    expect(validateSimulationLatex("<p>No formulas</p>")).toContain(
      "document must display its formulas with at least one sim-latex marker"
    );
    expect(
      validateSimulationLatex('<span class="sim-latex" data-display="wide">F=ma</span>').join(" ")
    ).toMatch(/every sim-latex marker/);
    expect(
      validateSimulationLatex(
        '<span class="sim-latex" data-display="inline">\\notARealCommand{x}</span>'
      ).join(" ")
    ).toMatch(/invalid LaTeX formula/);
  });

  it("leaves ordinary spans unchanged and safely falls back for invalid legacy markers", () => {
    expect(renderSimulationLatex('<span class="label">F = ma</span>')).toBe(
      '<span class="label">F = ma</span>'
    );
    expect(
      renderSimulationLatex(
        '<span class="sim-latex" data-display="inline">\\notARealCommand{&lt;x&gt;}</span>'
      )
    ).toContain('<span class="sim-formula-error">');
  });
});
