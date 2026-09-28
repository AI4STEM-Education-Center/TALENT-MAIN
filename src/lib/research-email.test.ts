import { describe, it, expect } from "vitest";
import {
  agreedPlaceLabel,
  filterPool,
  mergePoolEntries,
  normalizePoolAudience,
  recipientVars,
  renderResearchEmail,
  variantFor,
  type IrbPoolRow,
  type SurveyPoolRow,
} from "@/lib/research-email";
import { parseResearchEmailInput } from "@/lib/research-email-input";

const irb = (overrides: Partial<IrbPoolRow>): IrbPoolRow => ({
  userId: "u1",
  role: "STUDENT",
  decision: "AGREE",
  interviewRecordingChoice: "AUDIO_ONLY",
  signerNameSnapshot: "Ann Lee",
  signerEmailSnapshot: "ann@example.com",
  signedAt: "2026-09-01T00:00:00.000Z",
  user: { firstName: "Ann", lastName: "Lee", email: "ann@uga.edu" },
  ...overrides,
});

const optIn = (overrides: Partial<SurveyPoolRow>): SurveyPoolRow => ({
  userId: "u2",
  role: "STUDENT",
  interviewEmail: null,
  nameSnapshot: "Bo Kim",
  emailSnapshot: "bo@example.com",
  submittedAt: "2026-09-05T00:00:00.000Z",
  user: { firstName: "Bo", lastName: "Kim", email: "bo@uga.edu" },
  ...overrides,
});

describe("mergePoolEntries", () => {
  it("uses each person's latest consent decision (rows newest first)", () => {
    const pool = mergePoolEntries(
      [
        irb({ userId: "u1", decision: "DECLINE" }), // withdrew
        irb({ userId: "u1", decision: "AGREE" }),
        irb({
          userId: "u3",
          decision: "AGREE",
          user: null,
          signerNameSnapshot: "Cy Doe",
          signerEmailSnapshot: "cy@x.edu",
        }),
      ],
      [],
    );
    expect(pool.map((p) => p.key)).toEqual(["u3"]);
    expect(pool[0]).toMatchObject({
      firstName: "Cy",
      lastName: "Doe",
      email: "cy@x.edu",
    });
  });

  it("combines IRB and pre-survey agreement and prefers the survey contact email", () => {
    const pool = mergePoolEntries(
      [irb({ userId: "u1" })],
      [
        optIn({ userId: "u1", interviewEmail: "ann.personal@gmail.com" }),
        optIn({ userId: "u2" }),
      ],
    );
    const ann = pool.find((p) => p.key === "u1")!;
    expect(ann).toMatchObject({
      viaIrb: true,
      viaSurvey: true,
      consentLevel: "AUDIO_ONLY",
      email: "ann.personal@gmail.com",
    });
    const bo = pool.find((p) => p.key === "u2")!;
    expect(bo).toMatchObject({
      viaIrb: false,
      viaSurvey: true,
      email: "bo@uga.edu",
      consentLevel: null,
    });
    expect(agreedPlaceLabel(ann)).toBe(
      "the IRB consent form and the pre-survey",
    );
    expect(variantFor(ann)).toBe("IRB");
    expect(variantFor(bo)).toBe("SURVEY");
  });
});

describe("filterPool", () => {
  const pool = mergePoolEntries(
    [
      irb({ userId: "a", interviewRecordingChoice: "NO_INTERVIEW" }),
      irb({ userId: "b", interviewRecordingChoice: "VIDEO_AUDIO" }),
      irb({ userId: "t", role: "TEACHER" }),
    ],
    [optIn({ userId: "c" })],
  );

  it("filters by role, source and consent level", () => {
    const keys = (a: unknown) =>
      filterPool(pool, normalizePoolAudience(a))
        .map((p) => p.key)
        .sort();
    expect(keys({ roles: ["STUDENT"] })).toEqual(["a", "b", "c"]);
    expect(keys({ roles: ["TEACHER"] })).toEqual(["t"]);
    expect(keys({ roles: ["STUDENT"], sources: ["SURVEY"] })).toEqual(["c"]);
    expect(
      keys({ roles: ["STUDENT"], consentLevels: ["VIDEO_AUDIO", "NONE"] }),
    ).toEqual(["b", "c"]);
  });
});

describe("renderResearchEmail", () => {
  const content = {
    irbSubject: "Hi {{firstName}}",
    irbBody:
      "You agreed via {{agreedPlace}} ({{consentLevel}}). {{surveyLink}}",
    surveySubject: "",
    surveyBody: "",
  };

  it("substitutes variables and falls back to the other version when one is blank", () => {
    const vars = recipientVars(
      {
        firstName: "Bo",
        lastName: "Kim",
        role: "STUDENT",
        viaIrb: false,
        viaSurvey: true,
        consentLevel: null,
      },
      "AI4Talent",
      { surveyLink: "https://x/survey/abc" },
    );
    const out = renderResearchEmail(content, "SURVEY", vars);
    expect(out.subject).toBe("Hi Bo");
    expect(out.text).toBe(
      "You agreed via the pre-survey (). https://x/survey/abc",
    );
  });

  it("fills the consent level only for IRB agreement", () => {
    const vars = recipientVars(
      {
        firstName: "Ann",
        lastName: "Lee",
        role: "TEACHER",
        viaIrb: true,
        viaSurvey: false,
        consentLevel: "TRANSCRIPT_ONLY",
      },
      "AI4Talent",
    );
    expect(vars.consentLevel).toMatch(/transcribed/);
    expect(vars.role).toBe("Teacher");
  });

  it("keeps a subject on one line", () => {
    const out = renderResearchEmail(
      { ...content, irbSubject: "{{name}}" },
      "IRB",
      { name: "Evil\r\nBcc: x@y.z" },
    );
    expect(out.subject).toBe("Evil Bcc: x@y.z");
  });
});

describe("parseResearchEmailInput", () => {
  const base = {
    kind: "POST_SURVEY",
    replyTo: "team@uga.edu",
    irbSubject: "S",
    irbBody: "Go: {{surveyLink}}",
    surveySubject: "",
    surveyBody: "",
    attachments: [],
    audience: { roles: ["STUDENT"], target: "ALL" },
  };

  it("requires a reply-to address to send", () => {
    const r = parseResearchEmailInput({ ...base, replyTo: "" }, true);
    expect(r).toMatchObject({ ok: false });
    expect(parseResearchEmailInput({ ...base, replyTo: "" }, false).ok).toBe(
      true,
    );
  });

  it("requires {{surveyLink}} in every written post-survey version", () => {
    expect(parseResearchEmailInput(base, true).ok).toBe(true);
    const r = parseResearchEmailInput(
      { ...base, surveySubject: "S2", surveyBody: "no link" },
      true,
    );
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/surveyLink/),
    });
  });

  it("rejects an invalid reply-to even for drafts", () => {
    expect(
      parseResearchEmailInput({ ...base, replyTo: "nope" }, false).ok,
    ).toBe(false);
  });
});
