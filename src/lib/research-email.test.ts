import { describe, it, expect } from "vitest";
import {
  agreedPlaceLabel,
  DEFAULT_RESEARCH_EMAIL_VERSIONS,
  filterPool,
  legacyVersions,
  mergePoolEntries,
  normalizePoolAudience,
  parseVersions,
  recipientVars,
  renderResearchEmail,
  variantFor,
  versionKeyFor,
  versionKeysFor,
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
      irb({ userId: "d", interviewRecordingChoice: "NO_INTERVIEW" }),
      irb({ userId: "t", role: "TEACHER" }),
    ],
    [optIn({ userId: "c" }), optIn({ userId: "d" })],
  );
  const keys = (a: unknown) =>
    filterPool(pool, normalizePoolAudience(a))
      .map((p) => p.key)
      .sort();

  it("only reaches people who agreed to an interview", () => {
    // "a" agreed to the study but not to an interview; "d" said no interview
    // on the IRB form but opted in on the pre-survey.
    expect(keys({ roles: ["STUDENT"] })).toEqual(["b", "c", "d"]);
    expect(keys({ roles: ["TEACHER"] })).toEqual(["t"]);
  });

  it("filters by source, with the recording level narrowing the IRB route only", () => {
    expect(keys({ roles: ["STUDENT"], sources: ["SURVEY"] })).toEqual([
      "c",
      "d",
    ]);
    expect(keys({ roles: ["STUDENT"], sources: ["IRB"] })).toEqual(["b"]);
    expect(
      keys({ roles: ["STUDENT"], consentLevels: ["AUDIO_ONLY", "NONE"] }),
    ).toEqual(["c", "d"]);
    expect(
      normalizePoolAudience({ consentLevels: ["NO_INTERVIEW", "NONE"] })
        .consentLevels,
    ).toEqual([]);
  });
});

describe("versions", () => {
  it("gives post-survey one version per role and the interview two", () => {
    expect(versionKeysFor("POST_SURVEY", ["STUDENT", "TEACHER"])).toEqual([
      "STUDENT",
      "TEACHER",
    ]);
    expect(versionKeysFor("POOL", ["TEACHER"])).toEqual([
      "TEACHER_IRB",
      "TEACHER_SURVEY",
    ]);
    expect(
      versionKeyFor("POST_SURVEY", { role: "TEACHER", viaIrb: true }),
    ).toBe("TEACHER");
    expect(versionKeyFor("POOL", { role: "STUDENT", viaIrb: true })).toBe(
      "STUDENT_IRB",
    );
    expect(versionKeyFor("POOL", { role: "TEACHER", viaIrb: false })).toBe(
      "TEACHER_SURVEY",
    );
  });

  it("ships a default for every version, with a survey link where needed", () => {
    for (const kind of ["POOL", "POST_SURVEY"] as const)
      for (const key of versionKeysFor(kind, ["STUDENT", "TEACHER"])) {
        const v = DEFAULT_RESEARCH_EMAIL_VERSIONS[kind][key]!;
        expect(v.subject.trim() && v.body.trim()).toBeTruthy();
        if (kind === "POST_SURVEY") expect(v.body).toContain("{{surveyLink}}");
      }
    expect(DEFAULT_RESEARCH_EMAIL_VERSIONS.POOL.STUDENT_IRB?.subject).toBe(
      "Invitation to share your experience with {{appName}}",
    );
  });

  it("drops keys another kind uses", () => {
    expect(
      parseVersions(
        "POST_SURVEY",
        JSON.stringify({
          STUDENT: { subject: "S", body: "B" },
          STUDENT_IRB: { subject: "x", body: "y" },
        }),
      ),
    ).toEqual({ STUDENT: { subject: "S", body: "B" } });
  });
});

describe("renderResearchEmail", () => {
  const versions = {
    STUDENT_SURVEY: {
      subject: "Hi {{firstName}}",
      body: "You agreed via {{agreedPlace}} ({{consentLevel}}). {{surveyLink}}",
    },
  };

  it("substitutes variables", () => {
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
    const out = renderResearchEmail(versions, "STUDENT_SURVEY", vars);
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
      { STUDENT: { subject: "{{name}}", body: "" } },
      "STUDENT",
      { name: "Evil\r\nBcc: x@y.z" },
    );
    expect(out.subject).toBe("Evil Bcc: x@y.z");
  });

  it("renders legacy campaigns, falling back to the other version", () => {
    const legacy = legacyVersions({
      irbSubject: "Hi {{firstName}}",
      irbBody: "IRB body",
      surveySubject: "",
      surveyBody: "",
    });
    expect(renderResearchEmail(legacy, "SURVEY", { firstName: "Bo" })).toEqual({
      subject: "Hi Bo",
      text: "IRB body",
    });
  });
});

describe("parseResearchEmailInput", () => {
  const post = {
    kind: "POST_SURVEY",
    replyTo: "",
    versions: {
      STUDENT: { subject: "S", body: "Go: {{surveyLink}}" },
      TEACHER: { subject: "T", body: "no link yet" },
    },
    attachments: [],
    audience: { roles: ["STUDENT"], target: "ALL" },
  };
  const interview = {
    kind: "POOL",
    replyTo: "team@uga.edu",
    versions: {
      STUDENT_IRB: { subject: "S", body: "B" },
      STUDENT_SURVEY: { subject: "S", body: "B" },
    },
    attachments: [],
    audience: { roles: ["STUDENT"] },
  };

  it("lets a post-survey email go out without a reply-to", () => {
    expect(parseResearchEmailInput(post, true).ok).toBe(true);
  });

  it("requires a reply-to address to send the interview email", () => {
    expect(parseResearchEmailInput(interview, true).ok).toBe(true);
    const r = parseResearchEmailInput({ ...interview, replyTo: "" }, true);
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/reply-to/),
    });
    expect(
      parseResearchEmailInput({ ...interview, replyTo: "" }, false).ok,
    ).toBe(true);
  });

  it("requires {{surveyLink}} in every post-survey version that will send", () => {
    const r = parseResearchEmailInput(
      { ...post, audience: { roles: ["STUDENT", "TEACHER"], target: "ALL" } },
      true,
    );
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Teacher email.*surveyLink/),
    });
  });

  it("requires both interview versions for each selected role", () => {
    const r = parseResearchEmailInput(
      { ...interview, audience: { roles: ["STUDENT", "TEACHER"] } },
      true,
    );
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Teacher · IRB version/),
    });
  });

  it("rejects an invalid reply-to even for drafts", () => {
    expect(
      parseResearchEmailInput({ ...post, replyTo: "nope" }, false).ok,
    ).toBe(false);
  });
});
