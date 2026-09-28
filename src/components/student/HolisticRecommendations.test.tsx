import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESULT_STATUS } from "@/lib/exam-results";
import { HolisticRecommendations } from "./HolisticRecommendations";

describe("recommendation generation states", () => {
  it("shows loading for recoverable legacy results instead of claiming there are no materials", () => {
    const html = renderToStaticMarkup(
      <HolisticRecommendations
        recommendations={[]}
        status={RESULT_STATUS.SKIPPED_NO_CONSENT}
        metrics={null}
      />,
    );
    expect(html).toContain("Finding study");
    expect(html).not.toContain("No specific study material");
  });
  it("distinguishes provider failure from a successful empty recommendation", () => {
    const html = renderToStaticMarkup(
      <HolisticRecommendations
        recommendations={[]}
        status={RESULT_STATUS.FAILED}
        metrics={null}
      />,
    );
    expect(html).toContain("generate study recommendations");
    expect(html).not.toContain("No specific study material");
    expect(html).not.toContain("animate-spin");
  });
});
