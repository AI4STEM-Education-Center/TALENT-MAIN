import { prisma } from "@/lib/prisma";
import { simulationDisplayKey } from "@/lib/exam-results";

/**
 * Read models for the student's own content library: the two standalone pages
 * that answer "what has my teacher given me?" — every learning material shared
 * with a class the student is enrolled in, and every simulation generated for
 * the quizzes those classes were assigned.
 *
 * Class scoping is the whole point of this module, so it is expressed once here
 * and reused by the pages AND the routes that serve the underlying S3 objects.
 * Two separate paths reach a student:
 *
 *   materials   MaterialClass links a material to a class (the junction is the
 *               source of truth — LearningMaterial.classId is only the origin
 *               class and goes null when that class is deleted).
 *   simulations Question -> Quiz -> ClassQuiz -> Class. A teacher with quizzes
 *               1..10 who assigns 1-3 to class A, 4 to class B and 7-10 to
 *               class C must give each class exactly the simulations built for
 *               its own quizzes — nothing from the other two.
 *
 * Everything here takes a Student id (not a user id): resolve it once from the
 * session in the caller.
 */

/** A class that grants a student access to some piece of content. */
export type GrantingClass = { id: string; name: string };

export type StudentMaterial = {
  id: string;
  title: string | null;
  originalName: string;
  sizeBytes: number;
  totalPages: number;
  processingStatus: string;
  createdAt: string;
  topic: { id: string; name: string } | null;
  /** Every enrolled class this material reaches the student through. */
  classes: GrantingClass[];
};

export type StudentSimulation = {
  id: string;
  title: string | null;
  topic: string | null;
  learningGoal: string | null;
  version: number;
};

export type StudentSimulationQuiz = {
  quizId: string;
  quizName: string;
  topicName: string | null;
  simulations: StudentSimulation[];
};

export type StudentSimulationClass = {
  classId: string;
  className: string;
  quizzes: StudentSimulationQuiz[];
};

/**
 * Every learning material shared with a class the student is enrolled in,
 * newest first. A material linked to two of the student's classes is listed
 * once, carrying both class names.
 *
 * Only uploaded materials are listed: a row is created before the PDF is
 * pushed to S3 and stays "PENDING" until the upload is confirmed, so listing
 * those would offer students a document that does not exist yet.
 */
export async function listStudentMaterials(
  studentId: string,
): Promise<StudentMaterial[]> {
  const links = await prisma.materialClass.findMany({
    where: {
      class: { enrollments: { some: { studentId } } },
      material: { uploadStatus: "READY" },
    },
    orderBy: { material: { createdAt: "desc" } },
    select: {
      class: { select: { id: true, name: true } },
      material: {
        select: {
          id: true,
          title: true,
          originalName: true,
          sizeBytes: true,
          totalPages: true,
          processingStatus: true,
          createdAt: true,
          topic: { select: { id: true, name: true, contentType: true } },
        },
      },
    },
  });

  const byMaterial = new Map<string, StudentMaterial>();
  for (const link of links) {
    const { topic, createdAt, ...material } = link.material;
    const existing = byMaterial.get(material.id);
    if (existing) {
      // Same material, second enrolled class — record the extra grant only.
      if (!existing.classes.some((cls) => cls.id === link.class.id))
        existing.classes.push(link.class);
      continue;
    }
    byMaterial.set(material.id, {
      ...material,
      createdAt: createdAt.toISOString(),
      // Materials share the Topic table with quizzes; only MATERIAL tags label one.
      topic:
        topic?.contentType === "MATERIAL"
          ? { id: topic.id, name: topic.name }
          : null,
      classes: [link.class],
    });
  }

  return Array.from(byMaterial.values());
}

/**
 * The material, if it is shared with a class the student is enrolled in.
 * Returns null otherwise — callers turn that into a 404, never a 403, so a
 * student cannot probe for material ids outside their classes.
 */
export async function getStudentMaterial(
  studentId: string,
  materialId: string,
) {
  const material = await prisma.learningMaterial.findFirst({
    where: {
      id: materialId,
      uploadStatus: "READY",
      classLinks: { some: { class: { enrollments: { some: { studentId } } } } },
    },
    include: {
      pages: {
        orderBy: { pageNumber: "asc" },
        select: {
          id: true,
          pageNumber: true,
          keyConcept: true,
          description: true,
        },
      },
      classLinks: {
        where: { class: { enrollments: { some: { studentId } } } },
        select: { class: { select: { id: true, name: true } } },
      },
      topic: { select: { id: true, name: true, contentType: true } },
    },
  });
  if (!material) return null;

  return {
    ...material,
    topic:
      material.topic?.contentType === "MATERIAL"
        ? { id: material.topic.id, name: material.topic.name }
        : null,
    classes: material.classLinks.map((link) => link.class),
  };
}

/**
 * Every READY simulation the student may open, grouped class -> quiz. A quiz
 * only contributes to the classes it is actually assigned AND published to, so
 * the grouping is also the access rule: a class shows exactly the simulations
 * generated for its own quizzes.
 *
 * Within one quiz, simulations that read the same to a student (same title +
 * topic — see `simulationDisplayKey`) collapse to one entry: a ten-question
 * quiz often yields several artifacts teaching the identical concept, and the
 * post-quiz rail dedupes them the same way.
 */
export async function listStudentSimulations(
  studentId: string,
): Promise<StudentSimulationClass[]> {
  const assignments = await prisma.classQuiz.findMany({
    where: {
      published: true,
      class: { enrollments: { some: { studentId } } },
      quiz: {
        questions: {
          some: {
            simulation: { is: { status: "READY", storageKey: { not: null } } },
          },
        },
      },
    },
    orderBy: [{ quiz: { order: "asc" } }, { quiz: { createdAt: "asc" } }],
    select: {
      class: { select: { id: true, name: true } },
      quiz: {
        select: {
          id: true,
          name: true,
          topic: { select: { name: true, contentType: true } },
          questions: {
            where: {
              simulation: {
                is: { status: "READY", storageKey: { not: null } },
              },
            },
            orderBy: { createdAt: "asc" },
            select: {
              simulation: {
                select: {
                  id: true,
                  title: true,
                  topic: true,
                  learningGoal: true,
                  version: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const byClass = new Map<string, StudentSimulationClass>();
  for (const assignment of assignments) {
    const { class: cls, quiz } = assignment;
    const seen = new Set<string>();
    const simulations: StudentSimulation[] = [];
    for (const question of quiz.questions) {
      const sim = question.simulation;
      if (!sim) continue;
      const key = simulationDisplayKey({
        simulationId: sim.id,
        title: sim.title,
        topic: sim.topic,
        learningGoal: sim.learningGoal,
      });
      if (seen.has(key)) continue;
      seen.add(key);
      simulations.push(sim);
    }
    if (simulations.length === 0) continue;

    const group = byClass.get(cls.id) ?? {
      classId: cls.id,
      className: cls.name,
      quizzes: [],
    };
    group.quizzes.push({
      quizId: quiz.id,
      quizName: quiz.name,
      // Topic is shared with material tags; only a QUIZ topic labels a quiz.
      topicName: quiz.topic?.contentType === "QUIZ" ? quiz.topic.name : null,
      simulations,
    });
    byClass.set(cls.id, group);
  }

  return Array.from(byClass.values()).toSorted((a, b) =>
    a.className.localeCompare(b.className),
  );
}
