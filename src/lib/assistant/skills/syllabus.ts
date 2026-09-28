// Student and teacher skills: answer questions from a class's syllabus.
//
// The two skills share their handlers and differ only in which classes the
// caller can reach — a student's enrolled classes, a teacher's owned ones —
// resolved from the session-derived ids on the tool context, never from an
// argument. A classId outside that set reads as "not found".
//
// Tools hand back the stored, normalized syllabus (see src/lib/syllabus.ts),
// which the agent fences as untrusted data like every other tool result: the
// syllabus text came from an uploaded PDF.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  addDays,
  eventsBetween,
  isoDay,
  normalizeIsoDate,
  parseSyllabusContent,
  type SyllabusContent,
} from "@/lib/syllabus";
import type {
  AssistantSkill,
  AssistantTool,
  AssistantToolContext,
} from "../types";

type ReachableClass = { id: string; name: string };

/** Every class the caller can read a syllabus for, newest first. */
async function reachableClasses(
  ctx: AssistantToolContext,
): Promise<ReachableClass[]> {
  if (ctx.audience === "student" && ctx.studentId) {
    const rows = await prisma.classEnrollment.findMany({
      where: { studentId: ctx.studentId },
      orderBy: { joinedAt: "desc" },
      select: { class: { select: { id: true, name: true } } },
    });
    return rows.map((row) => row.class);
  }
  if (ctx.audience === "teacher" && ctx.teacherId) {
    return prisma.class.findMany({
      where: { teacherId: ctx.teacherId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    });
  }
  throw new Error("This tool is only available to students and teachers.");
}

async function loadSyllabi(
  classIds: string[],
): Promise<Map<string, SyllabusContent>> {
  const rows = await prisma.classSyllabus.findMany({
    where: { classId: { in: classIds }, content: { not: null } },
    select: { classId: true, content: true },
  });
  const out = new Map<string, SyllabusContent>();
  for (const row of rows) {
    const content = parseSyllabusContent(row.content);
    if (content) out.set(row.classId, content);
  }
  return out;
}

const listInput = z.object({});

function listSyllabiTool(name: string): AssistantTool<typeof listInput> {
  return {
    name,
    description:
      "List the classes you can see, each with its classId, name, and whether a syllabus has " +
      "been uploaded (plus its course title, code and term). Call this first — the other syllabus " +
      "tools need a classId from here.",
    activityLabel: "Listing class syllabi",
    input: listInput,
    handler: async (_args, ctx) => {
      const classes = await reachableClasses(ctx);
      const syllabi = await loadSyllabi(classes.map((cls) => cls.id));
      return {
        classes: classes.map((cls) => {
          const content = syllabi.get(cls.id);
          return {
            classId: cls.id,
            className: cls.name,
            hasSyllabus: Boolean(content),
            courseTitle: content?.courseTitle ?? null,
            courseCode: content?.courseCode ?? null,
            term: content?.term ?? null,
          };
        }),
      };
    },
  };
}

const getInput = z.object({
  classId: z
    .string()
    .min(1)
    .max(64)
    .describe("The classId returned by the syllabus listing tool."),
});

function getSyllabusTool(name: string): AssistantTool<typeof getInput> {
  return {
    name,
    description:
      "The full syllabus for one class: course details, instructor and TA contacts with office " +
      "hours, learning objectives, required materials, grading breakdown and scale, every policy " +
      "(attendance, late work, academic honesty, …), the complete dated schedule, and other info. " +
      "Use it for any question about the course's rules, people, grading or calendar.",
    activityLabel: "Reading the syllabus",
    input: getInput,
    handler: async (args, ctx) => {
      const cls = (await reachableClasses(ctx)).find(
        (row) => row.id === args.classId,
      );
      if (!cls) {
        return {
          found: false,
          message: "No class of yours matches that classId.",
        };
      }
      const content = (await loadSyllabi([cls.id])).get(cls.id);
      if (!content) {
        return {
          found: false,
          className: cls.name,
          message: "No syllabus has been uploaded for this class yet.",
        };
      }
      return {
        found: true,
        classId: cls.id,
        className: cls.name,
        today: isoDay(new Date()),
        syllabus: content,
      };
    },
  };
}

const MAX_DATE_WINDOW_DAYS = 366;

const datesInput = z.object({
  classId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Restrict to one class. Omit to cover every class you can see."),
  from: z
    .string()
    .max(10)
    .optional()
    .describe("First day to include, YYYY-MM-DD. Defaults to today."),
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_DATE_WINDOW_DAYS)
    .optional()
    .describe("How many days forward from `from` to include. Defaults to 14."),
});

function syllabusDatesTool(name: string): AssistantTool<typeof datesInput> {
  return {
    name,
    description:
      "Dated syllabus items — exams, quizzes, assignment and project due dates, holidays, " +
      "deadlines — in a date window, across one class or all of them, soonest first. Returns " +
      "today's date too. Use it for 'what's due this week', 'when is the next exam', and similar " +
      "calendar questions. Items the syllabus lists without a calendar date are not included; " +
      "read the full syllabus for those.",
    activityLabel: "Checking upcoming dates",
    input: datesInput,
    handler: async (args, ctx) => {
      const today = isoDay(new Date());
      const from = normalizeIsoDate(args.from) ?? today;
      const to = addDays(from, (args.days ?? 14) - 1);

      const classes = (await reachableClasses(ctx)).filter(
        (cls) => !args.classId || cls.id === args.classId,
      );
      if (args.classId && classes.length === 0) {
        return {
          found: false,
          message: "No class of yours matches that classId.",
        };
      }
      const syllabi = await loadSyllabi(classes.map((cls) => cls.id));

      const events = classes
        .flatMap((cls) => {
          const content = syllabi.get(cls.id);
          return content
            ? eventsBetween(content, from, to).map((event) => ({
                className: cls.name,
                classId: cls.id,
                ...event,
              }))
            : [];
        })
        .toSorted((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

      return {
        found: true,
        today,
        from,
        to,
        classesWithoutSyllabus: classes
          .filter((cls) => !syllabi.has(cls.id))
          .map((cls) => cls.name),
        events,
      };
    },
  };
}

const SHARED_INSTRUCTIONS = [
  "Answer from the syllabus only. Quote the policy, weight or date the tool returned and name " +
    "the class it came from; if the syllabus doesn't say, say so and suggest asking the " +
    "instructor rather than guessing.",
  "Tool results include today's date. Use it to resolve 'this week', 'next Friday', or 'how " +
    "long until the midterm', and state the actual date in your answer.",
  "When a schedule item has no calendar date, give its dateText (for example 'Week 3') as written.",
];

export const studentSyllabusSkill: AssistantSkill = {
  id: "student-syllabus",
  name: "Class syllabus",
  description:
    "Lets a student ask about the syllabus of any class they're enrolled in: due dates, exams, " +
    "grading, policies, office hours and contacts.",
  audience: "student",
  instructions: [
    "You can read the syllabus of every class this student is enrolled in with list_syllabi, " +
      "get_syllabus, and get_syllabus_dates. Use get_syllabus_dates for calendar questions and " +
      "get_syllabus for everything else.",
    ...SHARED_INSTRUCTIONS,
  ].join("\n"),
  tools: [
    listSyllabiTool("list_syllabi"),
    getSyllabusTool("get_syllabus"),
    syllabusDatesTool("get_syllabus_dates"),
  ],
};

export const teacherSyllabusSkill: AssistantSkill = {
  id: "teacher-syllabus",
  name: "Class syllabus",
  description:
    "Lets a teacher ask about the syllabi of their own classes: upcoming deadlines across " +
    "classes, grading weights, policies, and what students will see.",
  audience: "teacher",
  instructions: [
    "You can read the syllabus of each of this teacher's classes with list_class_syllabi, " +
      "get_class_syllabus, and get_class_syllabus_dates. What you read is exactly what their " +
      "students' assistant answers from, so point out anything missing or ambiguous — an " +
      "undated exam, weights that don't sum to 100% — when it's relevant.",
    "You cannot change the syllabus. To correct it, the teacher edits it or uploads a new " +
      "version on the class's Syllabus page.",
    ...SHARED_INSTRUCTIONS,
  ].join("\n"),
  tools: [
    listSyllabiTool("list_class_syllabi"),
    getSyllabusTool("get_class_syllabus"),
    syllabusDatesTool("get_class_syllabus_dates"),
  ],
};
