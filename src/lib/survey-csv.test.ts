import { describe, it, expect } from "vitest";
import { buildPoolCsv, buildSurveyResponsesCsv } from "@/lib/survey-csv";
import type { SurveyQuestion } from "@/lib/survey";

const questions: SurveyQuestion[] = [
  {
    id: "s1",
    type: "section",
    text: "Part 1",
    help: "",
    options: [],
    otherLabel: "",
    required: false,
  },
  {
    id: "q1",
    type: "single",
    text: "Pick",
    help: "",
    options: ["A", "B"],
    otherLabel: "",
    required: true,
  },
  {
    id: "q2",
    type: "multi",
    text: "Many, please",
    help: "",
    options: ["X", "Y"],
    otherLabel: "",
    required: false,
  },
  {
    id: "q3",
    type: "textarea",
    text: "Why?",
    help: "",
    options: [],
    otherLabel: "",
    required: false,
  },
];

describe("buildSurveyResponsesCsv", () => {
  it("writes one column per answerable question and guards formulas", () => {
    const csv = buildSurveyResponsesCsv(
      questions,
      [
        {
          id: "r1",
          submittedAt: new Date("2026-09-10T12:00:00Z"),
          role: "STUDENT",
          source: "LINK",
          nameSnapshot: "Ann Lee",
          emailSnapshot: "ann@uga.edu",
          userId: "u1",
          irbAgreed: true,
          interviewOptIn: true,
          interviewEmail: "ann@gmail.com",
          answers: { q1: "A", q2: ["X", "Y"], q3: '=HYPERLINK("x")' },
        },
      ],
      { includeInterview: true },
    );
    const [header, row] = csv.trimEnd().split("\r\n");
    expect(header).toContain("Interview Contact OK");
    expect(header).toContain("Q1: Pick");
    expect(header).toContain('"Q2: Many, please"');
    expect(header).not.toContain("Part 1");
    expect(row).toContain("Email link");
    expect(row).toContain("X; Y");
    expect(row).toContain('"\t=HYPERLINK(""x"")"');
  });
});

describe("buildPoolCsv", () => {
  it("labels where each person agreed and their consent level", () => {
    const csv = buildPoolCsv([
      {
        key: "u1",
        userId: "u1",
        firstName: "Ann",
        lastName: "Lee",
        name: "Ann Lee",
        email: "ann@uga.edu",
        role: "STUDENT",
        viaIrb: true,
        viaSurvey: false,
        consentLevel: "VIDEO_AUDIO",
        irbAgreedAt: "2026-09-01T00:00:00.000Z",
        surveyAgreedAt: null,
      },
    ]);
    expect(csv).toContain("the IRB consent form");
    expect(csv).toContain("Interview with video and audio recording");
  });
});
