import { describe, expect, it } from "vitest";
import {
  addDays,
  buildSyllabusExtractionPrompt,
  emptySyllabusContent,
  eventsBetween,
  extractionWarnings,
  formatIsoDay,
  isoDay,
  isSyllabusEmpty,
  normalizeIsoDate,
  normalizeSyllabusContent,
  parseSyllabusContent,
  SYLLABUS_EXTRACTION_SCHEMA,
} from "./syllabus";

describe("normalizeIsoDate", () => {
  it("accepts real calendar days and trims a time suffix", () => {
    expect(normalizeIsoDate("2026-09-15")).toBe("2026-09-15");
    expect(normalizeIsoDate("2026-09-15T10:00:00Z")).toBe("2026-09-15");
  });

  it("rejects impossible days and free text", () => {
    expect(normalizeIsoDate("2026-02-30")).toBeNull();
    expect(normalizeIsoDate("Week 3")).toBeNull();
    expect(normalizeIsoDate(20260915)).toBeNull();
  });
});

describe("normalizeSyllabusContent", () => {
  it("maps the model's snake_case output onto the stored shape", () => {
    const content = normalizeSyllabusContent({
      course_title: " Intro Physics ",
      course_code: "PHYS 1111",
      meeting_info: "MWF 10:10",
      contacts: [
        {
          role: "Instructor",
          name: "Dr. Rivera",
          email: "rivera@example.edu",
          phone: null,
          office: "Room 201",
          office_hours: "Tue 2-4pm",
        },
      ],
      learning_objectives: ["Apply Newton's laws", "  "],
      grading: [{ component: "Exams", weight: "50%" }],
      schedule: [
        {
          date: "2026-10-20",
          end_date: null,
          date_text: "Tue Oct 20",
          title: "Midterm",
          type: "exam",
          details: null,
        },
      ],
    });
    expect(content.courseTitle).toBe("Intro Physics");
    expect(content.meetingInfo).toBe("MWF 10:10");
    expect(content.contacts[0].officeHours).toBe("Tue 2-4pm");
    expect(content.learningObjectives).toEqual(["Apply Newton's laws"]);
    expect(content.schedule[0]).toMatchObject({
      date: "2026-10-20",
      dateText: "Tue Oct 20",
      type: "exam",
    });
  });

  it("round-trips its own camelCase output unchanged", () => {
    const once = normalizeSyllabusContent({
      courseTitle: "Chem",
      schedule: [{ date: "2026-09-01", title: "Lab 1", type: "lab" }],
      otherInfo: [{ title: "LMS", body: "eLC" }],
    });
    expect(normalizeSyllabusContent(once)).toEqual(once);
  });

  it("drops rows with nothing to identify them and coerces bad values", () => {
    const content = normalizeSyllabusContent({
      contacts: [{ role: "TA" }],
      grading: [{ weight: "10%" }],
      policies: [{ title: "", body: "" }, { body: "No late work." }],
      schedule: [
        { title: "" },
        { title: "Quiz", type: "pop-quiz", date: "not a date" },
      ],
    });
    expect(content.contacts).toEqual([]);
    expect(content.grading).toEqual([]);
    expect(content.policies).toEqual([
      { title: "Untitled", body: "No late work." },
    ]);
    expect(content.schedule).toEqual([
      {
        date: null,
        endDate: null,
        dateText: null,
        title: "Quiz",
        type: "other",
        details: null,
      },
    ]);
  });

  it("sorts dated items chronologically and keeps undated ones in order after", () => {
    const content = normalizeSyllabusContent({
      schedule: [
        { title: "Undated A" },
        { title: "Final", date: "2026-12-10" },
        { title: "Undated B" },
        { title: "Midterm", date: "2026-10-20" },
      ],
    });
    expect(content.schedule.map((e) => e.title)).toEqual([
      "Midterm",
      "Final",
      "Undated A",
      "Undated B",
    ]);
  });

  it("drops an end date that isn't after the start", () => {
    const [event] = normalizeSyllabusContent({
      schedule: [{ title: "Break", date: "2026-11-25", endDate: "2026-11-20" }],
    }).schedule;
    expect(event.endDate).toBeNull();
  });

  it("bounds long text and long lists", () => {
    const content = normalizeSyllabusContent({
      description: "x".repeat(50_000),
      learningObjectives: Array.from({ length: 500 }, (_, i) => `obj ${i}`),
    });
    expect(content.description!.length).toBeLessThanOrEqual(6_000);
    expect(content.learningObjectives.length).toBeLessThanOrEqual(60);
  });

  it("never throws on garbage", () => {
    expect(normalizeSyllabusContent(null)).toEqual(emptySyllabusContent());
    expect(normalizeSyllabusContent("nope")).toEqual(emptySyllabusContent());
    expect(normalizeSyllabusContent([1, 2])).toEqual(emptySyllabusContent());
  });
});

describe("parseSyllabusContent", () => {
  it("returns null for a missing or corrupt column", () => {
    expect(parseSyllabusContent(null)).toBeNull();
    expect(parseSyllabusContent("{")).toBeNull();
  });
});

describe("isSyllabusEmpty", () => {
  it("is true for an extraction that found nothing", () => {
    expect(isSyllabusEmpty(emptySyllabusContent())).toBe(true);
    expect(
      isSyllabusEmpty({ ...emptySyllabusContent(), courseTitle: "Bio" }),
    ).toBe(false);
  });
});

describe("extractionWarnings", () => {
  it("keeps only non-empty strings", () => {
    expect(extractionWarnings({ warnings: ["Year unclear", "", 4] })).toEqual([
      "Year unclear",
    ]);
  });
});

describe("dates", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("formats an ISO day without shifting it by the time zone", () => {
    expect(formatIsoDay("2026-09-15")).toBe("Tue, Sep 15, 2026");
  });

  it("reads today in the institution's zone, not UTC", () => {
    // 02:00 UTC on the 16th is still the evening of the 15th in New York.
    expect(isoDay(new Date("2026-09-16T02:00:00Z"))).toBe("2026-09-15");
  });

  it("finds events in a window, including one already underway", () => {
    const content = normalizeSyllabusContent({
      schedule: [
        { title: "Fall break", date: "2026-10-08", endDate: "2026-10-12" },
        { title: "Quiz 3", date: "2026-10-14" },
        { title: "Midterm", date: "2026-10-30" },
        { title: "Week 5 reading" },
      ],
    });
    expect(
      eventsBetween(content, "2026-10-10", "2026-10-20").map((e) => e.title),
    ).toEqual(["Fall break", "Quiz 3"]);
  });
});

describe("extraction schema + prompt", () => {
  it("requires every declared property, as strict mode demands", () => {
    const { properties, required } = SYLLABUS_EXTRACTION_SCHEMA.schema;
    expect([...required].sort()).toEqual(Object.keys(properties).sort());
  });

  it("tells the model today's date so it can infer the year", () => {
    expect(
      buildSyllabusExtractionPrompt(3, new Date("2026-09-15T12:00:00Z")),
    ).toContain("today is 2026-09-15");
  });
});
