import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESULT_STATUS } from "@/lib/exam-results";
import { ResultSummary } from "./ResultSummary";

describe("ResultSummary", () => {
  it("renders the same generated next steps for student and teacher result views", () => {
    const html = renderToStaticMarkup(
      <ResultSummary
        summary="### Focus next\nReview **energy conservation**."
        status={RESULT_STATUS.READY}
        metrics={null}
      />,
    );

    expect(html).toContain("Summary &amp; next steps");
    expect(html).toContain("Focus next");
    expect(html).toContain("energy conservation");
  });

  it("shows a stable failure state when no summary was generated", () => {
    const html = renderToStaticMarkup(
      <ResultSummary
        summary={null}
        status={RESULT_STATUS.FAILED}
        metrics={null}
      />,
    );

    expect(html).toContain("couldn&#x27;t generate a summary for this attempt");
  });
});
