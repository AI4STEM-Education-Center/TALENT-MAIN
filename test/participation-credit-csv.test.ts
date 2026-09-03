import { describe, expect, it } from "vitest";
import {
  buildParticipationCreditCsv,
  participationCount,
  type ParticipationCreditRow,
} from "@/lib/participation-credit-csv";

const rows: ParticipationCreditRow[] = [
  {
    orgDefinedId: "811947904",
    lastName: "Nash",
    firstName: "Aaron",
    quizzesCompleted: 3,
    completedAttempts: 5,
  },
  {
    orgDefinedId: "811107402",
    lastName: "Sherer",
    firstName: "Aaron",
    quizzesCompleted: 1,
    completedAttempts: 2,
  },
];

describe("participation credit CSV", () => {
  it("awards quiz-threshold credit and includes below-threshold students as zeroes", () => {
    const csv = buildParticipationCreditCsv({
      gradeColumnName: "Course Participation",
      pointsAwarded: 5,
      metric: "quizzes-completed",
      threshold: 2,
      rows,
    });

    expect(csv).toBe(
      "OrgDefinedId,Last Name,First Name,Course Participation Points Grade <Numeric MaxPoints:5>,End-of-Line Indicator\r\n" +
        "#811947904,Nash,Aaron,5,#\r\n" +
        "#811107402,Sherer,Aaron,0,#\r\n",
    );
  });

  it("can use total completed attempts as the threshold measure", () => {
    expect(participationCount(rows[0], "completed-attempts")).toBe(5);
    expect(participationCount(rows[0], "quizzes-completed")).toBe(3);

    const csv = buildParticipationCreditCsv({
      gradeColumnName: "Practice Credit",
      pointsAwarded: 2.5,
      metric: "completed-attempts",
      threshold: 4,
      rows,
    });

    expect(csv).toContain(
      "Practice Credit Points Grade <Numeric MaxPoints:2.5>",
    );
    expect(csv).toContain("#811947904,Nash,Aaron,2.5,#");
    expect(csv).toContain("#811107402,Sherer,Aaron,0,#");
  });
});
