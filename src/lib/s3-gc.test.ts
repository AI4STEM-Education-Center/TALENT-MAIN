import { describe, expect, it } from "vitest";
import { classifyForGc, type GcRefs } from "./s3-gc";

function refs(partial: Partial<GcRefs> = {}): GcRefs {
  return {
    materialIds: new Set(),
    extractionStatusById: new Map(),
    figureKeys: new Set(),
    simulationKeys: new Set(),
    ...partial,
  };
}

describe("classifyForGc", () => {
  describe("learning-materials family", () => {
    const pdf = "learning-materials/t1/c1/mat1/notes.pdf";
    const page = "learning-materials/t1/c1/mat1/pages/page-3.png";

    it("keeps every object of a live material", () => {
      const r = refs({ materialIds: new Set(["mat1"]) });
      expect(classifyForGc(pdf, r)).toBe("keep");
      expect(classifyForGc(page, r)).toBe("keep");
    });

    it("deletes every object of a deleted material", () => {
      const r = refs({ materialIds: new Set(["other"]) });
      expect(classifyForGc(pdf, r)).toBe("delete");
      expect(classifyForGc(page, r)).toBe("delete");
    });

    it("keeps keys too short to carry a material id", () => {
      expect(classifyForGc("learning-materials/t1/stray.pdf", refs())).toBe(
        "keep",
      );
    });
  });

  describe("quiz-extractions family", () => {
    const pdf = "quiz-extractions/t1/quiz1/ext1/upload.pdf";
    const page = "quiz-extractions/t1/quiz1/ext1/pages/page-1.png";
    const figure = "quiz-extractions/t1/quiz1/ext1/figures/figure-0.png";
    const optionCrop = "quiz-extractions/t1/quiz1/ext1/figures/option-0-1.png";

    it("keeps the whole prefix while the extraction is not committed", () => {
      for (const status of [
        "PENDING_UPLOAD",
        "EXTRACTING",
        "AWAITING_REVIEW",
        "FAILED",
      ]) {
        const r = refs({ extractionStatusById: new Map([["ext1", status]]) });
        expect(classifyForGc(pdf, r)).toBe("keep");
        expect(classifyForGc(page, r)).toBe("keep");
        expect(classifyForGc(figure, r)).toBe("keep");
      }
    });

    it("keeps only referenced figures once committed", () => {
      const r = refs({
        extractionStatusById: new Map([["ext1", "COMMITTED"]]),
        figureKeys: new Set([figure]),
      });
      expect(classifyForGc(figure, r)).toBe("keep");
      expect(classifyForGc(optionCrop, r)).toBe("delete"); // crop no question kept
      expect(classifyForGc(pdf, r)).toBe("delete");
      expect(classifyForGc(page, r)).toBe("delete");
    });

    it("keeps referenced figures of a DELETED extraction (deep copies share keys)", () => {
      const r = refs({ figureKeys: new Set([figure, optionCrop]) });
      expect(classifyForGc(figure, r)).toBe("keep");
      expect(classifyForGc(optionCrop, r)).toBe("keep");
      expect(classifyForGc(pdf, r)).toBe("delete");
      expect(classifyForGc(page, r)).toBe("delete");
    });

    it("works for pool-scoped keys", () => {
      const poolFigure =
        "quiz-extractions/pool/quiz9/ext9/figures/figure-2.png";
      expect(
        classifyForGc(poolFigure, refs({ figureKeys: new Set([poolFigure]) })),
      ).toBe("keep");
      expect(classifyForGc(poolFigure, refs())).toBe("delete");
    });
  });

  describe("simulations family", () => {
    const current = "simulations/t1/quiz1/q1/v3.html";
    const previous = "simulations/t1/quiz1/q1/v2.html";
    const orphan = "simulations/t1/quiz1/q1/v1.html";

    it("keeps current and feedback-referenced versions, deletes the rest", () => {
      const r = refs({ simulationKeys: new Set([current, previous]) });
      expect(classifyForGc(current, r)).toBe("keep");
      expect(classifyForGc(previous, r)).toBe("keep");
      expect(classifyForGc(orphan, r)).toBe("delete");
    });
  });

  describe("environment namespace", () => {
    const devKey = "dev/simulations/t1/quiz1/q1/v1.html";

    it("classifies keys inside the active namespace against full stored references", () => {
      expect(
        classifyForGc(
          devKey,
          refs({ simulationKeys: new Set([devKey]) }),
          "dev/",
        ),
      ).toBe("keep");
      expect(classifyForGc(devKey, refs(), "dev/")).toBe("delete");
    });

    it("never deletes an object outside the active namespace", () => {
      expect(
        classifyForGc("simulations/t1/quiz1/q1/v1.html", refs(), "dev/"),
      ).toBe("keep");
    });
  });

  it("never touches prefixes it does not manage", () => {
    expect(classifyForGc("backups/2026-07-01.sqlite", refs())).toBe("keep");
    expect(classifyForGc("some-random-object.txt", refs())).toBe("keep");
  });
});
