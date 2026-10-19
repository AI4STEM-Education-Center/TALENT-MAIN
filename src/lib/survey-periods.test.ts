import { describe, it, expect } from "vitest";
import {
  decisionAsOf,
  isPostSurveyEligible,
  parseSurveyPeriod,
  periodForKind,
  pickDuePostSurvey,
  repromptCampaign,
  resolveSurveyGate,
  shouldRepromptConsent,
  surveyFormLabel,
  type PromptedPostForm,
} from "@/lib/survey";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

const p1: PromptedPostForm = { id: "p1", period: 1, promptStartedAt: day(10) };
const p2: PromptedPostForm = { id: "p2", period: 2, promptStartedAt: day(20) };
const agreedOn = (n: number) => [{ decision: "AGREE", signedAt: day(n) }];

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
    consentHistory: agreedOn(1),
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
    const h = { decision: "AGREE" as const, consentHistory: agreedOn(1) };
    expect(
      isPostSurveyEligible({ ...h, firstPreSubmittedAt: day(10) }, p1),
    ).toBe(false);
    expect(
      isPostSurveyEligible({ ...h, firstPreSubmittedAt: day(9) }, p1),
    ).toBe(true);
  });

  it("excludes a decliner who took the optional pre-survey and re-consents now", () => {
    const history = (agreedDay: number) => [
      { decision: "DECLINE", signedAt: day(1) },
      { decision: "AGREE", signedAt: day(agreedDay) },
    ];
    // Agreed between the prompts: only period 2.
    expect(
      pickDuePostSurvey({ ...base, consentHistory: history(12) })?.id,
    ).toBe("p2");
    expect(
      pickDuePostSurvey({ ...base, consentHistory: history(22) }),
    ).toBeNull();
    expect(pickDuePostSurvey({ ...base, consentHistory: [] })).toBeNull();
  });

  it("uses the standing decision at the cutoff, not any past AGREE", () => {
    // AGREE → pre-survey → DECLINE before the cutoff → AGREE after it.
    const consentHistory = [
      { decision: "AGREE", signedAt: day(1) },
      { decision: "DECLINE", signedAt: day(5) },
      { decision: "AGREE", signedAt: day(12) },
    ];
    expect(decisionAsOf(consentHistory, day(10))).toBe("DECLINE");
    expect(decisionAsOf(consentHistory, day(1))).toBeNull();
    expect(pickDuePostSurvey({ ...base, consentHistory })?.id).toBe("p2");
  });

  it("carries an AGREE across a consent version change between periods", () => {
    // v1 AGREE in period 1; v2 published later and agreed to again.
    const consentHistory = [
      { decision: "AGREE", signedAt: day(1) },
      { decision: "AGREE", signedAt: day(15) },
    ];
    expect(pickDuePostSurvey({ ...base, consentHistory })?.id).toBe("p1");
  });
});

describe("IRB re-consent campaign", () => {
  it("starts when the most recent current prompt did", () => {
    expect(repromptCampaign([])).toBeNull();
    expect(repromptCampaign([p1, p2])).toEqual({
      form: p2,
      startedAt: day(20),
    });
    expect(
      repromptCampaign([{ id: "x", period: 2, promptStartedAt: null }]),
    ).toBeNull();
  });

  const ask = (over: Partial<Parameters<typeof shouldRepromptConsent>[0]>) =>
    shouldRepromptConsent({
      decision: "DECLINE",
      decidedAt: day(5),
      campaignStart: day(20),
      lastDismissedAt: null,
      ...over,
    });

  it("asks decliners whose DECLINE predates the campaign", () => {
    expect(ask({})).toBe(true);
    expect(ask({ decision: "AGREE" })).toBe(false);
    expect(ask({ decision: null, decidedAt: null })).toBe(false);
    expect(ask({ campaignStart: null })).toBe(false);
  });

  it("ends with a fresh DECLINE made after the campaign started", () => {
    expect(ask({ decidedAt: day(21) })).toBe(false);
  });

  it("honours a dismissal made since the campaign started, even if a later prompt is turned off", () => {
    expect(ask({ lastDismissedAt: day(22) })).toBe(false);
    // Dismissed during period 2 (day 22); period 2's prompt turned off so the
    // campaign falls back to period 1's start (day 10): still dismissed.
    expect(ask({ campaignStart: day(10), lastDismissedAt: day(22) })).toBe(
      false,
    );
    // A dismissal from an earlier campaign doesn't cover a new one.
    expect(ask({ lastDismissedAt: day(12) })).toBe(true);
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
    consentHistory: agreedOn(1),
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
        consentHistory: agreedOn(12),
      }),
    ).toEqual({ state: "NONE" });
    // Took the optional pre-survey while declining, agreed only now.
    expect(
      resolveSurveyGate({
        ...base,
        consentHistory: [
          { decision: "DECLINE", signedAt: day(1) },
          { decision: "AGREE", signedAt: day(12) },
        ],
      }),
    ).toEqual({
      state: "NONE",
    });
  });
});
