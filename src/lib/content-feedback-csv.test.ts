import { describe, it, expect } from "vitest";
import {
  buildFeedbackCsv,
  buildFeedbackSummaryCsv,
  feedbackCsvFilename,
  type FeedbackExportRow,
} from "@/lib/content-feedback-csv";
import { summarizeFeedbackBySubject } from "@/lib/content-feedback";

const at = new Date("2026-09-04T12:30:00.000Z");

const exportRow = (
  overrides: Partial<FeedbackExportRow> = {},
): FeedbackExportRow => ({
  id: "fb-1",
  createdAt: at,
  updatedAt: at,
  audience: "STUDENT",
  subjectType: "SIMULATION",
  subjectId: "sim-1",
  subjectLabel: "Waves",
  subjectDetail: "See how frequency changes",
  rating: 4,
  comment: "Helped me see the phase shift.",
  authorName: "Stu Student",
  authorEmail: "stu@example.com",
  authorRole: "STUDENT",
  className: "Physics 101",
  quizName: "Quiz 2",
  attemptId: "att-1",
  ...overrides,
});

function parse(csv: string) {
  return csv.trimEnd().split("\r\n");
}

describe("buildFeedbackCsv", () => {
  it("writes a header and one CRLF-terminated line per verdict", () => {
    const csv = buildFeedbackCsv([exportRow()]);
    const lines = parse(csv);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Feedback ID,Submitted At \(UTC\)/);
    expect(lines[1]).toContain("2026-09-04T12:30:00.000Z");
    expect(lines[1]).toContain("Useful");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("quotes fields containing commas, quotes, and newlines", () => {
    const csv = buildFeedbackCsv([
      exportRow({ comment: 'Great, but the "damping" slider\nbroke' }),
    ]);
    expect(csv).toContain('"Great, but the ""damping"" slider\nbroke"');
  });

  it("neutralizes a comment that a spreadsheet would run as a formula", () => {
    // A student can type anything here; =HYPERLINK(...) must land in the cell
    // as text, not execute when a teacher opens the file.
    const csv = buildFeedbackCsv([
      exportRow({ comment: '=HYPERLINK("http://evil.example","click")' }),
    ]);
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csv).toContain('"\t=HYPERLINK(""http://evil.example"",""click"")"');
  });

  it("leaves missing optional context as empty fields", () => {
    const csv = buildFeedbackCsv([
      exportRow({
        subjectId: null,
        subjectDetail: null,
        authorName: null,
        authorEmail: null,
        className: null,
        quizName: null,
        attemptId: null,
      }),
    ]);
    expect(parse(csv)[1]).toContain(",,");
  });
});

describe("buildFeedbackSummaryCsv", () => {
  it("carries the count, average, and full histogram per subject", () => {
    const csv = buildFeedbackSummaryCsv(
      summarizeFeedbackBySubject([
        {
          audience: "STUDENT",
          subjectType: "SIMULATION",
          subjectId: "sim-1",
          subjectLabel: "Waves",
          rating: 1,
        },
        {
          audience: "STUDENT",
          subjectType: "SIMULATION",
          subjectId: "sim-1",
          subjectLabel: "Waves",
          rating: 5,
        },
      ]),
    );
    const lines = parse(csv);
    expect(lines[0]).toBe(
      "Subject Type,Subject,Subject ID,Ratings,Average Rating,1 - Not useful,2 - Slightly useful,3 - Somewhat useful,4 - Useful,5 - Very useful",
    );
    expect(lines[1]).toBe("SIMULATION,Waves,sim-1,2,3.00,1,0,0,0,1");
  });

  it("writes only a header when nothing has been rated", () => {
    expect(parse(buildFeedbackSummaryCsv([]))).toHaveLength(1);
  });
});

describe("feedbackCsvFilename", () => {
  it("dates the file and names the view", () => {
    expect(feedbackCsvFilename("detail", at)).toBe("feedback-2026-09-04.csv");
    expect(feedbackCsvFilename("summary", at)).toBe(
      "feedback-summary-2026-09-04.csv",
    );
  });
});
