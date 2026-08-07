import { describe, expect, it } from "vitest";
import { latestConsentDecisionsByEmail } from "@/lib/consent";

describe("latestConsentDecisionsByEmail", () => {
  it("uses the first valid row from newest-first records", () => {
    const decisions = latestConsentDecisionsByEmail([
      { signerEmailSnapshot: " Student@Example.com ", decision: "DECLINE" },
      { signerEmailSnapshot: "student@example.com", decision: "AGREE" },
    ]);
    expect(decisions.get("student@example.com")).toBe("DECLINE");
  });
});
