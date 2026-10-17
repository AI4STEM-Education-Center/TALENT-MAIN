import { describe, expect, it } from "vitest";
import {
  ACCEPTED_SIMULATION_SURFACES,
  LEGACY_SIMULATION_SURFACES,
  SIMULATION_SURFACES,
  SIMULATION_SURFACE_LABELS,
  classifyViewport,
  simulationSurfaceLabel,
  simulationViewportLabel,
} from "./simulation-telemetry";
import { simulationSessionCreateSchema } from "./validation";

describe("simulation surface vocabulary", () => {
  it("labels every current and legacy surface", () => {
    for (const surface of ACCEPTED_SIMULATION_SURFACES) {
      expect(SIMULATION_SURFACE_LABELS[surface]).toBeTruthy();
      expect(simulationSurfaceLabel(surface)).toBe(
        SIMULATION_SURFACE_LABELS[surface],
      );
    }
    expect(simulationSurfaceLabel("quiz_results")).toBe(
      "Quiz results (just submitted)",
    );
    expect(simulationSurfaceLabel("results_page")).toBe(
      "Results page (past attempt)",
    );
    expect(simulationSurfaceLabel("library")).toBe("Simulations library");
    expect(simulationSurfaceLabel("rail")).toBe(
      "Results rail (legacy, desktop)",
    );
    expect(simulationSurfaceLabel("mobile")).toBe(
      "Results rail (legacy, phone/tablet)",
    );
  });

  it("keeps legacy values out of the set new clients send", () => {
    for (const legacy of LEGACY_SIMULATION_SURFACES) {
      expect(SIMULATION_SURFACES).not.toContain(legacy);
    }
  });

  it("shows unknown values verbatim and never treats prototype keys as known", () => {
    expect(simulationSurfaceLabel("kiosk")).toBe("Other (kiosk)");
    expect(simulationSurfaceLabel("toString")).toBe("Other (toString)");
    expect(simulationSurfaceLabel("")).toBe("Unknown");
    expect(simulationSurfaceLabel(null)).toBe("Unknown");
  });
});

describe("viewport classification", () => {
  it("splits at the sm and lg breakpoints", () => {
    expect(classifyViewport(375)).toBe("phone");
    expect(classifyViewport(639)).toBe("phone");
    expect(classifyViewport(640)).toBe("tablet");
    expect(classifyViewport(1023)).toBe("tablet");
    expect(classifyViewport(1024)).toBe("desktop");
    expect(classifyViewport(2560)).toBe("desktop");
  });

  it("labels stored viewports and infers one for legacy rows", () => {
    expect(simulationViewportLabel("phone")).toBe("Phone");
    expect(simulationViewportLabel("desktop", "rail")).toBe("Desktop");
    expect(simulationViewportLabel(null, "rail")).toBe("Desktop");
    expect(simulationViewportLabel(null, "mobile")).toBe("Phone/tablet");
    expect(simulationViewportLabel(null, "library")).toBe("Unknown");
    expect(simulationViewportLabel("watch")).toBe("Other (watch)");
    expect(simulationViewportLabel("constructor")).toBe("Other (constructor)");
  });
});

describe("simulationSessionCreateSchema", () => {
  const parse = (body: unknown) =>
    simulationSessionCreateSchema.safeParse(body);

  it("accepts every current surface with an optional viewport and class", () => {
    for (const surface of SIMULATION_SURFACES) {
      const result = parse({ surface, viewport: "tablet", classId: "c1" });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        attemptId: null,
        classId: "c1",
        surface,
        viewport: "tablet",
      });
    }
  });

  it("still accepts legacy surfaces from cached clients, without a viewport", () => {
    for (const surface of LEGACY_SIMULATION_SURFACES) {
      const result = parse({ attemptId: "a1", surface });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        attemptId: "a1",
        classId: null,
        surface,
        viewport: null,
      });
    }
  });

  it("rejects surfaces and viewports outside the closed sets", () => {
    expect(parse({ surface: "kiosk" }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(parse({ surface: "library", viewport: "watch" }).success).toBe(
      false,
    );
    expect(parse({ surface: "library", classId: "x".repeat(65) }).success).toBe(
      false,
    );
  });
});
