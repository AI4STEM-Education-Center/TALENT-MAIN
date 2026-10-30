// Server side of the per-question "wrong-answer coach".
//
// The coach reuses the student assistant end to end (provider, guardrails,
// streaming loop, transcript storage and retention); this module only supplies
// what is specific to one missed question:
//
//   - resolving WHICH question, from the signed-in student's own ExamResult;
//   - what the model and the dialog may see of it (answer-key rule below);
//   - the study options the model may point at, and the checks that make those
//     pointers safe to render (materials/simulations the student was already
//     given, an alternative question the practice routes would also serve);
//   - turning stored action references back into renderable cards.
//
// ANSWER-KEY RULE. The results page is deliberately answer-key-free: missed
// prompts plus the student's own response, nothing else. While the student can
// still retake the quiz the coach keeps to that — the model is told the key is
// withheld and is not given the unselected choices. Once the attempt is final
// (same `retakeStillPossible` test as the assistant's get_quiz_result_detail)
// the full question, key and teacher explanation are shared as review. An
// alternative-version retake is never final, so its key is always withheld.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  parseReviewSnapshot,
  parseStoredRecommendations,
  snapshotToStudentMistakes,
  type SnapshotQuestion,
  type StoredRecommendation,
} from "@/lib/exam-results";
import {
  presignStoredRecommendations,
  presignStudentMistakes,
} from "@/lib/exam-results-engine";
import { presignOptionImage } from "@/lib/question-figures";
import { retakeStillPossible } from "@/lib/student-answer-key";
import { studentCanPractice } from "@/lib/quiz-practice-access";
import { neutralizeUntrusted, fenceUntrusted } from "@/lib/guardrail-fence";
import { shuffleAnswerChoices } from "@/lib/quiz-shuffle";
import {
  scoreVariant,
  variantQuestionSchema,
  type VariantQuestion,
} from "@/lib/quiz-variants";
import {
  COACH_OBSERVE_MAX,
  COACH_REASON_MAX,
  COACH_STEPS_MAX,
  COACH_STEP_MAX,
  type CoachActionRef,
  type CoachActionView,
  type CoachPracticeQuestionView,
  type CoachQuestionView,
  type CoachScope,
} from "./coach-types";

/** Longest slice of a simulation's build spec shown to the model. */
const SIM_DESCRIPTION_CHARS = 900;

// ─── Resolving the question ──────────────────────────────────────────────────

/**
 * The missed question the student asked about, or null when it cannot be
 * verified. Null covers every failure — someone else's attempt, an unknown
 * attempt, a question number outside the snapshot, a question the student got
 * RIGHT — and the routes answer all of them with the same 404, so the endpoint
 * is no oracle for other students' attempts or for which answers were correct.
 */
export async function resolveCoachScope(
  studentId: string,
  resultId: string,
  questionNumber: number,
): Promise<CoachScope | null> {
  if (!Number.isInteger(questionNumber) || questionNumber < 1) return null;

  const result = await prisma.examResult.findUnique({
    where: { quizAttemptId: resultId },
    select: {
      studentId: true,
      classId: true,
      quizId: true,
      quizName: true,
      topicName: true,
      className: true,
      reviewSnapshot: true,
      practiceVersionName: true,
    },
  });
  if (!result || result.studentId !== studentId) return null;
  // A class an admin has paused hides its content even from a student who is
  // still in another active class (the proxy only blocks fully paused ones).
  if (result.classId) {
    const cls = await prisma.class.findUnique({
      where: { id: result.classId },
      select: { disabledAt: true },
    });
    if (cls?.disabledAt) return null;
  }

  const question = parseReviewSnapshot(result.reviewSnapshot).questions[
    questionNumber - 1
  ];
  // Strictly false: a snapshot row with no verdict is not "wrong".
  if (!question || question.isCorrect !== false) return null;

  // An alternative retake is recorded in the same pipeline as a graded attempt
  // but is never final, so its key stays withheld (same rule as the assistant's
  // get_quiz_result_detail). The version it ran on is kept so the coach does
  // not offer that very question back as a fresh practice question.
  const alternative = result.practiceVersionName !== null;
  const ownVersionId = alternative
    ? ((
        await prisma.quizPracticeAttempt.findFirst({
          where: { quizAttemptId: resultId, studentId },
          select: { versionId: true },
        })
      )?.versionId ?? null)
    : null;

  return {
    studentId,
    resultId,
    questionNumber,
    classId: result.classId,
    quizId: result.quizId,
    quizName: result.quizName,
    topicName: result.topicName,
    className: result.className,
    questionId:
      typeof question.questionId === "string" ? question.questionId : null,
    question,
    alternativeVersionName: result.practiceVersionName,
    ownVersionId,
    answerKeyAvailable:
      !alternative &&
      !(await retakeStillPossible(studentId, result.classId, result.quizId)),
  };
}

/** The assistant's first line. Static: no model call is spent on a greeting. */
export function coachOpening(questionNumber: number): string {
  return (
    `Let's look at question ${questionNumber} together. Before I say anything: ` +
    "what were you thinking when you answered it? Walk me through how you approached it."
  );
}

/** Conversation title an admin sees in the transcript browser. */
export function coachConversationTitle(scope: CoachScope): string {
  return `Coach · ${scope.quizName} · Question ${scope.questionNumber}`.slice(
    0,
    120,
  );
}

// ─── What the dialog shows ───────────────────────────────────────────────────

/**
 * The original question for the dialog's reference pane. The student's own
 * response comes from the same reducer as the results page, so it cannot show
 * more than that page does; the answer key is attached only when allowed.
 */
export async function buildCoachQuestionView(
  scope: CoachScope,
): Promise<CoachQuestionView> {
  const [source] = snapshotToStudentMistakes({ questions: [scope.question] });
  const [mistake] = await presignStudentMistakes([
    { ...source, questionNumber: scope.questionNumber },
  ]);

  return {
    questionNumber: scope.questionNumber,
    quizName: scope.quizName,
    text: mistake.text,
    figureUrl: mistake.figureUrl,
    figureAlt: mistake.figureAlt,
    response: mistake.response,
    review: scope.answerKeyAvailable ? await buildReview(scope) : null,
  };
}

async function buildReview(
  scope: CoachScope,
): Promise<NonNullable<CoachQuestionView["review"]>> {
  const q = scope.question;
  const options = Array.isArray(q.options) ? q.options : [];
  const choices = await Promise.all(
    options.map(async (option) => ({
      text: typeof option.text === "string" ? option.text : "",
      imageUrl: await presignOptionImage({
        imageStorageKey:
          typeof option.imageStorageKey === "string"
            ? option.imageStorageKey
            : null,
        imageBucket: null,
      }),
      imageAlt: typeof option.imageAlt === "string" ? option.imageAlt : null,
      selected: option.selected === true,
      correct: option.isCorrect === true,
    })),
  );
  return {
    choices,
    correctNumeric:
      typeof q.correctNumeric === "number" ? q.correctNumeric : null,
    unit: typeof q.unit === "string" ? q.unit : null,
    explanation: await liveExplanation(scope),
  };
}

/**
 * The teacher's authored explanation, when the live question still reads like
 * the one that was graded. The snapshot is durable but does not carry feedback
 * text, so an explanation written for an edited question is dropped rather than
 * shown against the wrong prompt.
 */
async function liveExplanation(scope: CoachScope): Promise<string | null> {
  if (!scope.questionId) return null;
  const live = await prisma.question.findUnique({
    where: { id: scope.questionId },
    select: { text: true, feedbackGeneral: true, feedbackIncorrect: true },
  });
  if (!live || live.text !== scope.question.text) return null;
  const parts = [live.feedbackGeneral, live.feedbackIncorrect]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ─── Study options the coach may point at ────────────────────────────────────

export type CoachMaterialOption = {
  /** What the model passes back: 1-based, stable for this attempt. */
  number: number;
  recommendationIndex: number;
  title: string;
  pages: string;
  reason: string;
};
export type CoachSimulationOption = {
  simulationId: string;
  title: string;
  topic: string | null;
  learningGoal: string | null;
  version: number;
  /** Trimmed build brief: grounds the how-to in what the simulation really has. */
  description: string | null;
  /** True for the simulation attached to this very question. */
  forThisQuestion: boolean;
};
export type CoachCandidates = {
  materials: CoachMaterialOption[];
  simulations: CoachSimulationOption[];
  /** An existing alternative-version question for THIS question, or null. */
  practice: { versionId: string; variantQuestionId: string } | null;
};

function pageLabel(rec: StoredRecommendation): string {
  const { start, end } = rec.pageRange ?? { start: 0, end: 0 };
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

/**
 * Everything the coach may offer for this question, gathered under the same
 * access rules the student routes apply. Called again by every tool handler
 * and by hydration, so a candidate list that was valid when the prompt was
 * built is re-validated at the moment a card is created or rendered.
 */
export async function loadCoachCandidates(
  scope: CoachScope,
): Promise<CoachCandidates> {
  const [result, ownSim, practice] = await Promise.all([
    prisma.examResult.findUnique({
      where: { quizAttemptId: scope.resultId },
      select: { recommendations: true, recommendationsStatus: true },
    }),
    scope.questionId
      ? prisma.questionSimulation.findUnique({
          where: { questionId: scope.questionId },
          select: { id: true },
        })
      : null,
    findPracticeOffer(scope),
  ]);

  const stored = parseStoredRecommendations(result?.recommendations ?? null);
  const materials = stored.items.flatMap<CoachMaterialOption>((rec, index) =>
    typeof rec?.materialTitle === "string"
      ? [
          {
            number: index + 1,
            recommendationIndex: index,
            title: rec.materialTitle,
            pages: pageLabel(rec),
            reason: typeof rec.reason === "string" ? rec.reason : "",
          },
        ]
      : [],
  );

  const simulationIds = [
    ...new Set([
      ...(ownSim ? [ownSim.id] : []),
      ...(stored.simulations ?? []).map((sim) => sim.simulationId),
    ]),
  ];
  return {
    materials,
    simulations: await loadSimulationOptions(
      scope,
      simulationIds,
      ownSim?.id ?? null,
    ),
    practice,
  };
}

async function loadSimulationOptions(
  scope: CoachScope,
  ids: string[],
  ownId: string | null,
): Promise<CoachSimulationOption[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.questionSimulation.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      title: true,
      topic: true,
      learningGoal: true,
      version: true,
      storageKey: true,
      simSpec: true,
      question: { select: { quizId: true } },
    },
  });
  const ready = rows.filter((row) => row.status === "READY" && row.storageKey);

  // The same rule as GET /api/simulations/[id]/content for a student: enrolled
  // in a class the simulation's quiz is assigned to. Checked here so the coach
  // never offers a simulation the viewer would then 404.
  const assigned = new Set(
    (
      await prisma.classQuiz.findMany({
        where: {
          quizId: { in: [...new Set(ready.map((row) => row.question.quizId))] },
          class: { enrollments: { some: { studentId: scope.studentId } } },
        },
        select: { quizId: true },
      })
    ).map((row) => row.quizId),
  );

  const byId = new Map(
    ready
      .filter((row) => assigned.has(row.question.quizId))
      .map((row) => [row.id, row]),
  );
  // Keep the order of `ids` (this question's own simulation first).
  return ids.flatMap<CoachSimulationOption>((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [
      {
        simulationId: row.id,
        title: row.title ?? row.topic ?? "Interactive simulation",
        topic: row.topic,
        learningGoal: row.learningGoal,
        version: row.version,
        description: row.simSpec
          ? neutralizeUntrusted(row.simSpec).slice(0, SIM_DESCRIPTION_CHARS)
          : null,
        forThisQuestion: id === ownId,
      },
    ];
  });
}

// ─── Alternative-version practice ────────────────────────────────────────────

const variantQuestionsSchema = z.array(variantQuestionSchema);

type PracticeMatch = { versionId: string; variant: VariantQuestion };

/**
 * The published alternative-version question that stands in for `scope`'s
 * question, if one exists and the student may practice this quiz right now.
 * Nothing is generated: this only reads what teachers already published.
 * Versions the student has not practiced yet come first, so a second ask
 * tends to surface different numbers than the first.
 */
async function findPracticeOffer(
  scope: CoachScope,
): Promise<{ versionId: string; variantQuestionId: string } | null> {
  if (!scope.questionId) return null;
  if (!(await studentCanPractice(scope.studentId, scope.classId, scope.quizId)))
    return null;

  const [versions, attempts] = await Promise.all([
    prisma.quizPracticeVersion.findMany({
      where: { quizId: scope.quizId, status: "PUBLISHED" },
      orderBy: { createdAt: "asc" },
      select: { id: true, questions: true },
    }),
    prisma.quizPracticeAttempt.findMany({
      where: {
        studentId: scope.studentId,
        classId: scope.classId,
        quizId: scope.quizId,
      },
      select: { versionId: true },
    }),
  ]);
  const seen = new Set(attempts.map((attempt) => attempt.versionId));

  const matches = versions.flatMap<PracticeMatch>((version) => {
    if (version.id === scope.ownVersionId) return [];
    const variant = parseVariantFor(version.questions, scope.questionId!);
    return variant ? [{ versionId: version.id, variant }] : [];
  });
  const pick = matches.find((m) => !seen.has(m.versionId)) ?? matches[0];
  return pick
    ? { versionId: pick.versionId, variantQuestionId: pick.variant.id }
    : null;
}

function parseVariantFor(
  rawQuestions: string,
  sourceQuestionId: string,
): VariantQuestion | null {
  let json: unknown;
  try {
    json = JSON.parse(rawQuestions);
  } catch {
    return null;
  }
  const parsed = variantQuestionsSchema.safeParse(json);
  if (!parsed.success) return null;
  return (
    parsed.data.find((q) => q.sourceQuestionId === sourceQuestionId) ?? null
  );
}

/**
 * Re-verify a (version, variant question) pair against the scope: the student
 * may practice this quiz, the version is still PUBLISHED for it, and the
 * variant really is the stand-in for the question they asked about. A pair that
 * fails any check is "not found" — nothing about versions the student has no
 * claim on is revealed.
 */
async function findPracticeMatch(
  scope: CoachScope,
  versionId: string,
  variantQuestionId: string,
): Promise<PracticeMatch | null> {
  if (!scope.questionId) return null;
  if (!(await studentCanPractice(scope.studentId, scope.classId, scope.quizId)))
    return null;
  // The version an alternative retake ran on is its own question, not practice.
  if (versionId === scope.ownVersionId) return null;
  const version = await prisma.quizPracticeVersion.findFirst({
    where: { id: versionId, quizId: scope.quizId, status: "PUBLISHED" },
    select: { id: true, questions: true },
  });
  if (!version) return null;
  const variant = parseVariantFor(version.questions, scope.questionId);
  if (!variant || variant.id !== variantQuestionId) return null;
  return { versionId: version.id, variant };
}

/**
 * Student-safe view of a variant question. Same explicit allowlist as
 * studentVariantQuestions: never the key, the solution, the objectives or the
 * AI review. The choice order is fixed per attempt and question so a reload
 * shows the same layout.
 */
function practiceView(
  scope: CoachScope,
  match: PracticeMatch,
): CoachPracticeQuestionView {
  const { variant } = match;
  return {
    versionId: match.versionId,
    questionId: variant.id,
    text: variant.text,
    answerMode: variant.answerMode,
    answerUnit: variant.answerUnit,
    options: shuffleAnswerChoices(
      variant.options,
      `coach:${scope.resultId}:${variant.id}`,
    ).map((o) => ({ id: o.id, text: o.text })),
  };
}

export const practiceAnswerSchema = z.object({
  versionId: z.string().min(1).max(64),
  questionId: z.string().min(1).max(200),
  selectedOptionId: z.string().min(1).max(200).optional(),
  numericValue: z.union([z.number(), z.string().max(40)]).optional(),
});

/**
 * Grade one answer to an offered practice question. Stateless on purpose: a
 * QuizPracticeAttempt archives a whole version's worth of answers and feeds the
 * practice history, and a single coached question is neither. Returns null for
 * anything that does not verify; otherwise ONLY whether the answer was right —
 * the practice feature never exposes keys or solutions to students.
 */
export async function gradeCoachPractice(
  scope: CoachScope,
  input: z.infer<typeof practiceAnswerSchema>,
): Promise<{ correct: boolean } | null> {
  const match = await findPracticeMatch(
    scope,
    input.versionId,
    input.questionId,
  );
  if (!match) return null;
  try {
    const scored = scoreVariant(
      [match.variant],
      [
        {
          questionId: match.variant.id,
          selectedOptionId: input.selectedOptionId,
          numericValue: input.numericValue,
        },
      ],
      `coach:${scope.resultId}`,
    );
    return { correct: scored.answerRecords[0]?.isCorrect === true };
  } catch {
    // An option id that is not one of this question's choices.
    return null;
  }
}

// ─── Action references ───────────────────────────────────────────────────────

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * The shape of a stored action reference. Also the validator for what comes
 * back out of the database, so a hand-edited or older row can only ever fail to
 * render, never render something unvetted.
 */
export const coachActionRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("material"),
    recommendationIndex: z.number().int().min(0).max(50),
    reason: text(COACH_REASON_MAX),
  }),
  z.object({
    kind: z.literal("simulation"),
    simulationId: z.string().min(1).max(64),
    goal: text(COACH_REASON_MAX),
    steps: z.array(text(COACH_STEP_MAX)).min(1).max(COACH_STEPS_MAX),
    observe: text(COACH_OBSERVE_MAX),
  }),
  z.object({
    kind: z.literal("practice"),
    versionId: z.string().min(1).max(64),
    variantQuestionId: z.string().min(1).max(200),
    reason: text(COACH_REASON_MAX),
  }),
]);

/**
 * The model-written text on a stored action, for the guardrail audit: card
 * text reaches the student like a reply does, so it is audited like one.
 */
export function coachActionText(raw: unknown[] | undefined): string[] {
  return (raw ?? []).flatMap((entry) => {
    const parsed = coachActionRefSchema.safeParse(entry);
    if (!parsed.success) return [];
    const ref = parsed.data;
    return ref.kind === "simulation"
      ? [ref.goal, ...ref.steps, ref.observe]
      : [ref.reason];
  });
}

/** A candidate set is loaded at most once per hydration pass. */
function memoCandidates(scope: CoachScope): () => Promise<CoachCandidates> {
  let pending: Promise<CoachCandidates> | null = null;
  return () => (pending ??= loadCoachCandidates(scope));
}

/** Turn one validated reference into a card, or null if it no longer verifies. */
export async function hydrateCoachAction(
  ref: CoachActionRef,
  scope: CoachScope,
  getCandidates: () => Promise<CoachCandidates> = memoCandidates(scope),
): Promise<CoachActionView | null> {
  if (ref.kind === "material") {
    const candidates = await getCandidates();
    const option = candidates.materials.find(
      (m) => m.recommendationIndex === ref.recommendationIndex,
    );
    if (!option) return null;
    const result = await prisma.examResult.findUnique({
      where: { quizAttemptId: scope.resultId },
      select: { recommendations: true },
    });
    const item = parseStoredRecommendations(result?.recommendations ?? null)
      .items[ref.recommendationIndex];
    if (!item) return null;
    // Presign through the same path the results page uses, one item at a time.
    const presigned = await presignStoredRecommendations(
      JSON.stringify({ items: [item], truncated: false }),
    );
    const recommendation = presigned.items[0];
    return recommendation
      ? { kind: "material", reason: ref.reason, recommendation }
      : null;
  }

  if (ref.kind === "simulation") {
    const candidates = await getCandidates();
    const sim = candidates.simulations.find(
      (s) => s.simulationId === ref.simulationId,
    );
    if (!sim) return null;
    return {
      kind: "simulation",
      simulation: {
        simulationId: sim.simulationId,
        title: sim.title,
        topic: sim.topic,
        learningGoal: sim.learningGoal,
        version: sim.version,
      },
      goal: ref.goal,
      steps: ref.steps,
      observe: ref.observe,
    };
  }

  const match = await findPracticeMatch(
    scope,
    ref.versionId,
    ref.variantQuestionId,
  );
  return match
    ? {
        kind: "practice",
        reason: ref.reason,
        question: practiceView(scope, match),
      }
    : null;
}

/** Hydrate a stored `actions` array, silently dropping anything that fails. */
export async function hydrateCoachActions(
  raw: unknown[] | undefined,
  scope: CoachScope,
): Promise<CoachActionView[]> {
  if (!raw?.length) return [];
  const getCandidates = memoCandidates(scope);
  const views: CoachActionView[] = [];
  for (const entry of raw) {
    const parsed = coachActionRefSchema.safeParse(entry);
    if (!parsed.success) continue;
    const view = await hydrateCoachAction(parsed.data, scope, getCandidates);
    if (view) views.push(view);
  }
  return views;
}

// ─── Prompt context ──────────────────────────────────────────────────────────

/** The plain data the context block is built from. Pure, so it is unit-testable. */
export type CoachContextInput = {
  quizName: string;
  className: string;
  topicName: string;
  questionNumber: number;
  question: SnapshotQuestion;
  answerKeyAvailable: boolean;
  explanation: string | null;
  candidates: CoachCandidates;
};

function formatStudentAnswer(q: SnapshotQuestion): string {
  if (q.answerMode === "NUMERIC") {
    if (typeof q.submittedNumeric !== "number") return "(no answer given)";
    return q.unit
      ? `${q.submittedNumeric} ${q.unit}`
      : String(q.submittedNumeric);
  }
  const picked = (Array.isArray(q.options) ? q.options : [])
    .filter((o) => o?.selected === true)
    .map((o) => o.text || o.imageAlt || "(image choice)");
  return picked.length > 0 ? picked.join("; ") : "(no answer given)";
}

/**
 * The question and study options as one fenced data block for the system
 * prompt. Fenced because the question text is teacher-authored or lifted from
 * an uploaded PDF — it must never be read as instructions.
 */
export function formatCoachContext(input: CoachContextInput): string {
  const { question: q, candidates } = input;
  const lines: string[] = [
    `Quiz: ${input.quizName}${input.topicName ? ` (topic: ${input.topicName})` : ""}, class: ${input.className}`,
    `Question ${input.questionNumber}: ${q.text}`,
  ];
  if (q.figureAlt)
    lines.push(`The question has a figure. Alt text: ${q.figureAlt}`);
  lines.push(
    `Answer type: ${q.answerMode === "NUMERIC" ? "numeric" : "choose from options"}`,
    `The student's answer (marked wrong): ${formatStudentAnswer(q)}`,
  );

  if (input.answerKeyAvailable) {
    lines.push(
      "ANSWER KEY: available — the attempt is final, so you may review it.",
    );
    if (q.answerMode === "NUMERIC") {
      lines.push(
        `Correct value: ${q.correctNumeric ?? "unknown"}${q.unit ? ` ${q.unit}` : ""}` +
          (typeof q.tolerance === "number" ? ` (±${q.tolerance})` : ""),
      );
    } else {
      lines.push("Options:");
      for (const o of Array.isArray(q.options) ? q.options : []) {
        const marks = [
          o.isCorrect ? "correct" : null,
          o.selected ? "student chose this" : null,
        ].filter(Boolean);
        lines.push(
          `- ${o.text || o.imageAlt || "(image choice)"}${marks.length ? ` [${marks.join(", ")}]` : ""}`,
        );
      }
    }
    if (input.explanation)
      lines.push(`Teacher's explanation: ${input.explanation}`);
  } else {
    lines.push(
      "ANSWER KEY: withheld — the student can still retake this quiz. You do not know the correct " +
        "answer or the other options and must not state, guess or narrow down which answer is right.",
    );
  }

  lines.push("", "Study options you may point the student to:");
  lines.push(
    candidates.materials.length > 0
      ? "Materials (use recommend_material with the number):\n" +
          candidates.materials
            .map(
              (m) =>
                `${m.number}. "${m.title}", ${m.pages}${m.reason ? ` — ${m.reason}` : ""}`,
            )
            .join("\n")
      : "Materials: none available for this attempt.",
  );
  lines.push(
    candidates.simulations.length > 0
      ? "Simulations (use explain_simulation with the id):\n" +
          candidates.simulations
            .map(
              (s) =>
                `- id ${s.simulationId}: "${s.title}"${s.forThisQuestion ? " (built for this question)" : ""}` +
                `${s.learningGoal ? `; goal: ${s.learningGoal}` : ""}` +
                `${s.description ? `; description: ${s.description}` : ""}`,
            )
            .join("\n")
      : "Simulations: none available.",
  );
  lines.push(
    candidates.practice
      ? "Practice question: an alternative-version question for this exact question exists (use offer_practice_question). You cannot see it."
      : "Practice question: none available — do not offer one.",
  );

  return fenceUntrusted("question context", lines.join("\n"));
}

/** Load everything the system prompt needs for one coach turn. */
export async function buildCoachContext(scope: CoachScope): Promise<string> {
  const [candidates, explanation] = await Promise.all([
    loadCoachCandidates(scope),
    scope.answerKeyAvailable ? liveExplanation(scope) : null,
  ]);
  return formatCoachContext({
    quizName: scope.quizName,
    className: scope.className,
    topicName: scope.topicName,
    questionNumber: scope.questionNumber,
    question: scope.question,
    answerKeyAvailable: scope.answerKeyAvailable,
    explanation,
    candidates,
  });
}
