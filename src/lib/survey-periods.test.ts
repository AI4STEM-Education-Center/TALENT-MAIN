import { describe, it, expect } from "vitest";
import {
  isPostSurveyEligible,
  parseSurveyPeriod,
  periodForKind,
  pickDuePostSurvey,
  repromptCampaignKey,
  resolveSurveyGate,
  shouldRepromptConsent,
  surveyFormLabel,
  type PromptedPostForm,
} from "@/lib/survey";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

const p1: PromptedPostForm = { id: "p1", period: 1, promptStartedAt: day(10) };
const p2: PromptedPostForm = { id: "p2", period: 2, promptStartedAt: day(20) };

describe("study period labels", () => {
  it("names forms by kind and period", () => {
    expect(surveyFormLabel("PRE", 1)).toBe("Pre-survey");
    expect(surveyFormLabel("PRE", 2)).toBe("Pre-survey");
    expect(surveyFormLabel("POST", 1)).toBe("Period 1 post-survey");
    expect(surveyFormLabel("POST", 2)).toBe("Period 2 post-survey");
    expect(surveyFormLabel("POST", 7)).toBe("Post-survey");
  });

  it("parses periods and pins PRE to period 1", () => {
    expect(parseSurveyPeriod(2)).toBe(2);
    expect(parseSurveyPeriod("2")).toBe(2);
    expect(parseSurveyPeriod(3)).toBe(1);
    expect(parseSurveyPeriod(undefined, 2)).toBe(2);
    expect(periodForKind("PRE", 2)).toBe(1);
    expect(periodForKind("POST", "2")).toBe(2);
    expect(periodForKind("POST", null)).toBe(1);
  });
});

describe("pickDuePostSurvey", () => {
  const base = {
    decision: "AGREE" as const,
    firstPreSubmittedAt: day(1),
    firstAgreedAt: day(1),
    forms: [p2, p1],
    respondedFormIds: new Set<string>(),
  };

  it("picks the lowest unanswered period for a participant who joined before the prompt", () => {
    expect(pickDuePostSurvey(base)?.id).toBe("p1");
    expect(
      pickDuePostSurvey({ ...base, respondedFormIds: new Set(["p1"]) })?.id,
    ).toBe("p2");
    expect(
      pickDuePostSurvey({ ...base, respondedFormIds: new Set(["p1", "p2"]) }),
    ).toBeNull();
  });

  it("requires an IRB AGREE as the latest decision", () => {
    expect(pickDuePostSurvey({ ...base, decision: "DECLINE" })).toBeNull();
    expect(pickDuePostSurvey({ ...base, decision: null })).toBeNull();
  });

  it("skips periods that started before the person joined the study", () => {
    // Pre-survey between the period 1 and period 2 prompts: only period 2.
    expect(
      pickDuePostSurvey({ ...base, firstPreSubmittedAt: day(15) })?.id,
    ).toBe("p2");
    // Recruited after both prompts (e.g. a decliner who re-consented): none.
    expect(
      pickDuePostSurvey({ ...base, firstPreSubmittedAt: day(25) }),
    ).toBeNull();
    expect(
      pickDuePostSurvey({ ...base, firstPreSubmittedAt: null }),
    ).toBeNull();
  });

  it("ignores forms without a prompt start", () => {
    expect(
      pickDuePostSurvey({
        ...base,
        forms: [{ id: "x", period: 1, promptStartedAt: null }],
      }),
    ).toBeNull();
  });

  it("treats a pre-survey at the exact prompt start as too late", () => {
    const h = { decision: "AGREE" as const, firstAgreedAt: day(1) };
    expect(
      isPostSurveyEligible({ ...h, firstPreSubmittedAt: day(10) }, p1),
    ).toBe(false);
    expect(
      isPostSurveyEligible({ ...h, firstPreSubmittedAt: day(9) }, p1),
    ).toBe(true);
  });

  it("excludes a decliner who took the optional pre-survey and re-consents now", () => {
    // Pre-survey during period 1, but the first AGREE comes after the prompt.
    expect(pickDuePostSurvey({ ...base, firstAgreedAt: day(12) })?.id).toBe(
      "p2",
    );
    expect(pickDuePostSurvey({ ...base, firstAgreedAt: day(22) })).toBeNull();
    expect(pickDuePostSurvey({ ...base, firstAgreedAt: null })).toBeNull();
  });
});

describe("IRB re-consent campaign", () => {
  it("is keyed by the most recently started prompt", () => {
    expect(repromptCampaignKey([])).toBeNull();
    expect(repromptCampaignKey([p1, p2])).toBe("p2");
    expect(
      repromptCampaignKey([{ id: "x", period: 2, promptStartedAt: null }]),
    ).toBeNull();
  });

  it("asks only decliners who haven't said no to this campaign", () => {
    const ask = (decision: "AGREE" | "DECLINE" | null, dismissed = false) =>
      shouldRepromptConsent({ decision, campaignKey: "p2", dismissed });
    expect(ask("DECLINE")).toBe(true);
    expect(ask("DECLINE", true)).toBe(false);
    expect(ask("AGREE")).toBe(false);
    expect(ask(null)).toBe(false);
    expect(
      shouldRepromptConsent({
        decision: "DECLINE",
        campaignKey: null,
        dismissed: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSurveyGate", () => {
  const base = {
    hasActiveConsentForm: true,
    decision: "AGREE" as const,
    repromptPending: false,
    preFormId: "pre" as string | null,
    preDismissed: false,
    postForms: [p1],
    respondedFormIds: new Set<string>(["pre"]),
    firstPreSubmittedAt: day(1),
    firstAgreedAt: day(1),
  };

  it("shows the pre-survey before any post-survey", () => {
    expect(resolveSurveyGate({ ...base, respondedFormIds: new Set() })).toEqual(
      { state: "DUE", kind: "PRE", formId: "pre", mandatory: true },
    );
  });

  it("then a mandatory post-survey for the current period", () => {
    expect(resolveSurveyGate(base)).toEqual({
      state: "DUE",
      kind: "POST",
      formId: "p1",
      period: 1,
      mandatory: true,
    });
    expect(
      resolveSurveyGate({ ...base, respondedFormIds: new Set(["pre", "p1"]) }),
    ).toEqual({ state: "NONE" });
  });

  it("waits for a consent decision or a pending re-consent prompt", () => {
    expect(resolveSurveyGate({ ...base, decision: null })).toEqual({
      state: "CONSENT_PENDING",
    });
    expect(
      resolveSurveyGate({
        ...base,
        decision: "DECLINE",
        repromptPending: true,
      }),
    ).toEqual({ state: "CONSENT_PENDING" });
  });

  it("keeps the optional pre-survey for decliners and never a post-survey", () => {
    const declined = {
      ...base,
      decision: "DECLINE" as const,
      respondedFormIds: new Set<string>(),
    };
    expect(resolveSurveyGate(declined)).toEqual({
      state: "DUE",
      kind: "PRE",
      formId: "pre",
      mandatory: false,
    });
    expect(resolveSurveyGate({ ...declined, preDismissed: true })).toEqual({
      state: "NONE",
    });
  });

  it("still prompts the post-survey when no pre-survey form is enabled", () => {
    expect(resolveSurveyGate({ ...base, preFormId: null })).toMatchObject({
      kind: "POST",
      formId: "p1",
    });
  });

  it("does not hand a freshly re-consented participant the old period's survey", () => {
    // Agreed and took the pre-survey after the period 1 prompt started.
    expect(
      resolveSurveyGate({
        ...base,
        firstPreSubmittedAt: day(12),
        firstAgreedAt: day(12),
      }),
    ).toEqual({ state: "NONE" });
    // Took the optional pre-survey while declining, agreed only now.
    expect(resolveSurveyGate({ ...base, firstAgreedAt: day(12) })).toEqual({
      state: "NONE",
    });
  });
});
