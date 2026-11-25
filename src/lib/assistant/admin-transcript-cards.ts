// Server-side card & question hydration for Admin Chat Transcripts.
//
// Unlike student hydration (`hydrateCoachActions` / `hydrateStudyActions`),
// admins and research scientists inspect historical and archived transcripts
// read-only, so hydration must NOT filter out paused classes, unenrolled
// students, closed quiz windows, or retired practice versions. Every lookup
// is isolated and explicitly allowlisted so a single malformed record or
// deleted resource degrades only its own card without dropping the rest of
// the transcript or exposing raw storage keys / internal fields.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  mapPresignedRecommendations,
  parseReviewSnapshot,
  parseStoredRecommendations,
  type PresignedRecommendation,
  type StoredRecommendation,
} from "@/lib/exam-results";
import { getS3Config, signObjectReadUrl } from "@/lib/storage";
import { shuffleAnswerChoices } from "@/lib/quiz-shuffle";
import { variantQuestionSchema } from "@/lib/quiz-variants";
import { readCardRef } from "./transcript-card-ref";
import { buildCoachQuestionView } from "./coach";
import type {
  CoachActionRef,
  CoachQuestionView,
  CoachScope,
} from "./coach-types";
import type { AssistantTurn } from "./types";
import type {
  AdminHydratedTranscript,
  AdminPracticeQuestionView,
  AdminTranscriptCard,
  AdminTranscriptTurn,
} from "./admin-transcript-types";

const variantQuestionsSchema = z.array(variantQuestionSchema);

type ParsedActionEntry = {
  ref: CoachActionRef;
  resultId: string | null;
};

function parseActionEntry(
  raw: unknown,
  defaultResultId: string | null,
): ParsedActionEntry | null {
  const ref = readCardRef(raw);
  if (!ref) return null;
  let resultId = defaultResultId;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).source === "study" &&
    typeof (raw as Record<string, unknown>).resultId === "string"
  ) {
    resultId = (raw as Record<string, unknown>).resultId as string;
  }
  return { ref, resultId };
}

function parseVariants(rawQuestions: string) {
  try {
    const parsed = variantQuestionsSchema.safeParse(JSON.parse(rawQuestions));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Validate a stored recommendation entry defensively without shifting indices
 * of later items in the array.
 */
function sanitizeStoredRecommendation(
  item: unknown,
): StoredRecommendation | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const raw = item as Record<string, unknown>;
  const pageRange = raw.pageRange as Record<string, unknown> | undefined;
  if (
    typeof raw.materialTitle !== "string" ||
    (raw.materialId !== undefined && typeof raw.materialId !== "string") ||
    !pageRange ||
    typeof pageRange !== "object" ||
    !Number.isInteger(pageRange.start) ||
    !Number.isInteger(pageRange.end) ||
    !Array.isArray(raw.pages)
  ) {
    return null;
  }
  const pages = raw.pages.flatMap((page) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) return [];
    const p = page as Record<string, unknown>;
    return Number.isInteger(p.pageNumber) && typeof p.storageKey === "string"
      ? [{ pageNumber: p.pageNumber as number, storageKey: p.storageKey }]
      : [];
  });
  return {
    ...(typeof raw.materialId === "string"
      ? { materialId: raw.materialId }
      : {}),
    materialTitle: raw.materialTitle,
    pageRange: {
      start: pageRange.start as number,
      end: pageRange.end as number,
    },
    reason: typeof raw.reason === "string" ? raw.reason : "",
    pages,
  };
}

type ExamResultLookup = {
  quizAttemptId: string;
  studentId: string;
  classId: string;
  quizId: string;
  quizName: string;
  topicName: string;
  className: string;
  reviewSnapshot: string;
  practiceVersionName: string | null;
  recommendations: string | null;
};

type MaterialLookup = {
  id: string;
  title: string | null;
  originalName: string;
  bucket: string | null;
  pages: { pageNumber: number; storageKey: string }[];
};

function defaultS3Bucket(): string | null {
  try {
    return getS3Config().bucket;
  } catch {
    return null;
  }
}

/** Explicit allowlisted turn projection: never forwards raw `actions` or `attachmentIds`. */
function sanitizeAdminTurn(
  turn: AssistantTurn,
  cards?: AdminTranscriptCard[],
): AdminTranscriptTurn {
  const attachmentNames = Array.isArray(turn.attachmentNames)
    ? turn.attachmentNames.filter(
        (name): name is string => typeof name === "string",
      )
    : [];
  return {
    role: turn.role,
    content: turn.content,
    ...(attachmentNames.length > 0 ? { attachmentNames } : {}),
    ...(cards && cards.length > 0 ? { cards } : {}),
  };
}

/** Pure fallback when DB hydration cannot run at all: keeps allowlisted card refs. */
export function fallbackAdminTurns(
  turns: AssistantTurn[],
): AdminTranscriptTurn[] {
  return turns.map((turn) => {
    if (turn.role !== "assistant" || !Array.isArray(turn.actions)) {
      return sanitizeAdminTurn(turn);
    }
    const cards = turn.actions.flatMap<AdminTranscriptCard>((raw) => {
      const ref = readCardRef(raw);
      if (!ref) return [];
      switch (ref.kind) {
        case "diagnostic_options":
          return [ref];
        case "material":
          return [
            {
              kind: "material",
              ...(ref.cardId ? { cardId: ref.cardId } : {}),
              recommendationIndex: ref.recommendationIndex,
              reason: ref.reason,
              recommendation: null,
              ...(ref.interaction ? { interaction: ref.interaction } : {}),
            },
          ];
        case "simulation":
          return [
            {
              kind: "simulation",
              ...(ref.cardId ? { cardId: ref.cardId } : {}),
              simulationId: ref.simulationId,
              simulation: null,
              goal: ref.goal,
              steps: ref.steps,
              observe: ref.observe,
              ...(ref.interaction ? { interaction: ref.interaction } : {}),
            },
          ];
        case "practice":
          return [
            {
              kind: "practice",
              ...(ref.cardId ? { cardId: ref.cardId } : {}),
              versionId: ref.versionId,
              variantQuestionId: ref.variantQuestionId,
              reason: ref.reason,
              ...(ref.questionText ? { questionText: ref.questionText } : {}),
              question: null,
              ...(ref.interaction ? { interaction: ref.interaction } : {}),
            },
          ];
      }
    });
    return sanitizeAdminTurn(turn, cards);
  });
}

async function presignMaterialForAdmin(
  item: StoredRecommendation,
  materials: MaterialLookup[],
  fallbackBucket: string | null,
): Promise<PresignedRecommendation> {
  const material = item.materialId
    ? materials.find((row) => row.id === item.materialId)
    : materials.find(
        (row) =>
          item.pages.length > 0 &&
          item.pages.every((page) =>
            row.pages.some((live) => live.storageKey === page.storageKey),
          ),
      );

  const title =
    material?.title?.trim() || material?.originalName || item.materialTitle;
  const resolvedMaterialId = material?.id ?? item.materialId ?? null;
  const pageRange = { start: item.pageRange.start, end: item.pageRange.end };
  const reason = item.reason;

  // Only sign live pages from a LearningMaterial row that still exists; if the
  // material was deleted, return metadata only without signing any keys.
  const bucket = material ? (material.bucket ?? fallbackBucket) : null;
  const livePages = material
    ? item.pages.flatMap((page) => {
        const match = material.pages.find(
          (candidate) => candidate.pageNumber === page.pageNumber,
        );
        return match ? [match] : [];
      })
    : [];

  if (!bucket || livePages.length === 0) {
    return {
      materialId: resolvedMaterialId,
      materialTitle: title,
      pageRange,
      reason,
      pages: [],
    };
  }

  try {
    const presigned = await mapPresignedRecommendations(
      {
        items: [
          {
            ...(resolvedMaterialId ? { materialId: resolvedMaterialId } : {}),
            materialTitle: title,
            pageRange,
            reason,
            pages: livePages,
          },
        ],
        truncated: false,
      },
      (key) => signObjectReadUrl(bucket, key),
    );
    const mapped = presigned.items[0];
    if (mapped) {
      return {
        materialId: mapped.materialId,
        materialTitle: mapped.materialTitle,
        pageRange: {
          start: mapped.pageRange.start,
          end: mapped.pageRange.end,
        },
        reason: mapped.reason,
        pages: mapped.pages.map((p) => ({
          pageNumber: p.pageNumber,
          imageUrl: p.imageUrl,
        })),
      };
    }
  } catch {
    // Fall back to metadata-only so the admin still sees the material title and page range.
  }

  return {
    materialId: resolvedMaterialId,
    materialTitle: title,
    pageRange,
    reason,
    pages: [],
  };
}

async function hydrateCoachQuestionForAdmin(
  result: ExamResultLookup | undefined,
  questionNumber: number | null,
): Promise<CoachQuestionView | null> {
  if (!result || !questionNumber || questionNumber < 1) return null;
  const question = parseReviewSnapshot(result.reviewSnapshot).questions[
    questionNumber - 1
  ];
  if (!question) return null;

  const scope: CoachScope = {
    studentId: result.studentId,
    resultId: result.quizAttemptId,
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
    ownVersionId: null,
    // Admins and research scientists always have full review/key access.
    answerKeyAvailable: true,
  };
  try {
    return await buildCoachQuestionView(scope);
  } catch {
    return null;
  }
}

/**
 * Hydrate every card in an admin transcript in a small fixed number of batched
 * queries (no N+1 per turn), plus the original missed question for coach chats.
 * Each table lookup is isolated so one failing query degrades only its own
 * card type instead of discarding the rest of the transcript.
 */
export async function hydrateAdminTranscript(conversation: {
  coachResultId?: string | null;
  coachQuestionNumber?: number | null;
  turns: AssistantTurn[];
}): Promise<AdminHydratedTranscript> {
  const defaultResultId = conversation.coachResultId ?? null;
  const parsedByTurn = conversation.turns.map((turn) =>
    turn.role === "assistant" && Array.isArray(turn.actions)
      ? turn.actions.flatMap((raw) => {
          const entry = parseActionEntry(raw, defaultResultId);
          return entry ? [entry] : [];
        })
      : [],
  );

  const resultIds = new Set<string>();
  const versionIds = new Set<string>();
  const simulationIds = new Set<string>();
  if (defaultResultId) resultIds.add(defaultResultId);
  for (const entries of parsedByTurn) {
    for (const { ref, resultId } of entries) {
      if (ref.kind === "material" && resultId) resultIds.add(resultId);
      else if (ref.kind === "practice") versionIds.add(ref.versionId);
      else if (ref.kind === "simulation") simulationIds.add(ref.simulationId);
    }
  }

  const [examResults, practiceVersions, simulations] = await Promise.all([
    resultIds.size > 0
      ? prisma.examResult
          .findMany({
            where: { quizAttemptId: { in: [...resultIds] } },
            select: {
              quizAttemptId: true,
              studentId: true,
              classId: true,
              quizId: true,
              quizName: true,
              topicName: true,
              className: true,
              reviewSnapshot: true,
              practiceVersionName: true,
              recommendations: true,
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
    versionIds.size > 0
      ? prisma.quizPracticeVersion
          .findMany({
            where: { id: { in: [...versionIds] } },
            select: { id: true, name: true, questions: true },
          })
          .catch(() => [])
      : Promise.resolve([]),
    simulationIds.size > 0
      ? prisma.questionSimulation
          .findMany({
            where: { id: { in: [...simulationIds] } },
            select: {
              id: true,
              title: true,
              topic: true,
              learningGoal: true,
              version: true,
              status: true,
              bucket: true,
              storageKey: true,
            },
          })
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  const resultById = new Map(examResults.map((r) => [r.quizAttemptId, r]));
  const storedRecsByResult = new Map<string, (StoredRecommendation | null)[]>();
  const materialIds = new Set<string>();
  const legacyPageKeys = new Set<string>();

  for (const entries of parsedByTurn) {
    for (const { ref, resultId } of entries) {
      if (ref.kind !== "material" || !resultId) continue;
      let items = storedRecsByResult.get(resultId);
      if (!items) {
        const res = resultById.get(resultId);
        items = parseStoredRecommendations(
          res?.recommendations ?? null,
        ).items.map(sanitizeStoredRecommendation);
        storedRecsByResult.set(resultId, items);
      }
      const item = items[ref.recommendationIndex];
      if (!item) continue;
      if (item.materialId) materialIds.add(item.materialId);
      else {
        for (const page of item.pages) legacyPageKeys.add(page.storageKey);
      }
    }
  }

  const materials: MaterialLookup[] =
    materialIds.size > 0 || legacyPageKeys.size > 0
      ? await prisma.learningMaterial
          .findMany({
            where: {
              OR: [
                ...(materialIds.size > 0
                  ? [{ id: { in: [...materialIds] } }]
                  : []),
                ...(legacyPageKeys.size > 0
                  ? [
                      {
                        pages: {
                          some: { storageKey: { in: [...legacyPageKeys] } },
                        },
                      },
                    ]
                  : []),
              ],
            },
            select: {
              id: true,
              title: true,
              originalName: true,
              bucket: true,
              pages: { select: { pageNumber: true, storageKey: true } },
            },
          })
          .catch(() => [])
      : [];

  const versionById = new Map(
    practiceVersions.map((v) => [
      v.id,
      { id: v.id, name: v.name, variants: parseVariants(v.questions) },
    ]),
  );
  const simById = new Map(simulations.map((s) => [s.id, s]));
  const fallbackBucket = defaultS3Bucket();
  const presignedMaterialCache = new Map<
    string,
    Promise<PresignedRecommendation>
  >();

  const [turns, coachQuestion] = await Promise.all([
    Promise.all(
      conversation.turns.map(async (turn, turnIndex) => {
        const entries = parsedByTurn[turnIndex];
        if (turn.role !== "assistant" || entries.length === 0) {
          return sanitizeAdminTurn(turn);
        }
        const cards: AdminTranscriptCard[] = await Promise.all(
          entries.map(
            async ({ ref, resultId }): Promise<AdminTranscriptCard> => {
              if (ref.kind === "diagnostic_options") return ref;

              if (ref.kind === "material") {
                const item = resultId
                  ? (storedRecsByResult.get(resultId)?.[
                      ref.recommendationIndex
                    ] ?? null)
                  : null;
                let recommendation: PresignedRecommendation | null = null;
                if (item && resultId) {
                  const cacheKey = `${resultId}:${ref.recommendationIndex}`;
                  let pending = presignedMaterialCache.get(cacheKey);
                  if (!pending) {
                    pending = presignMaterialForAdmin(
                      item,
                      materials,
                      fallbackBucket,
                    );
                    presignedMaterialCache.set(cacheKey, pending);
                  }
                  recommendation = await pending;
                }
                return {
                  kind: "material",
                  ...(ref.cardId ? { cardId: ref.cardId } : {}),
                  recommendationIndex: ref.recommendationIndex,
                  reason: ref.reason,
                  recommendation,
                  ...(ref.interaction ? { interaction: ref.interaction } : {}),
                };
              }

              if (ref.kind === "simulation") {
                const sim = simById.get(ref.simulationId);
                return {
                  kind: "simulation",
                  ...(ref.cardId ? { cardId: ref.cardId } : {}),
                  simulationId: ref.simulationId,
                  simulation: sim
                    ? {
                        simulationId: sim.id,
                        title:
                          sim.title ?? sim.topic ?? "Interactive simulation",
                        topic: sim.topic,
                        learningGoal: sim.learningGoal,
                        version: sim.version,
                        playable:
                          sim.status === "READY" &&
                          Boolean(sim.storageKey && sim.bucket),
                      }
                    : null,
                  goal: ref.goal,
                  steps: ref.steps,
                  observe: ref.observe,
                  ...(ref.interaction ? { interaction: ref.interaction } : {}),
                };
              }

              const version = versionById.get(ref.versionId);
              const variant = version?.variants.find(
                (candidate) => candidate.id === ref.variantQuestionId,
              );
              let question: AdminPracticeQuestionView | null = null;
              if (version && variant) {
                const orderedOptions = resultId
                  ? shuffleAnswerChoices(
                      variant.options,
                      `coach:${resultId}:${variant.id}`,
                    )
                  : variant.options;
                question = {
                  versionId: version.id,
                  versionName: version.name,
                  questionId: variant.id,
                  text: variant.text,
                  answerMode: variant.answerMode,
                  answerUnit: variant.answerUnit,
                  answerNumeric: variant.answerNumeric,
                  options: orderedOptions.map((option) => ({
                    id: option.id,
                    text: option.text,
                    isCorrect: option.isCorrect,
                  })),
                };
              }
              return {
                kind: "practice",
                ...(ref.cardId ? { cardId: ref.cardId } : {}),
                versionId: ref.versionId,
                variantQuestionId: ref.variantQuestionId,
                reason: ref.reason,
                ...(ref.questionText ? { questionText: ref.questionText } : {}),
                question,
                ...(ref.interaction ? { interaction: ref.interaction } : {}),
              };
            },
          ),
        );
        return sanitizeAdminTurn(turn, cards);
      }),
    ),
    hydrateCoachQuestionForAdmin(
      defaultResultId ? resultById.get(defaultResultId) : undefined,
      conversation.coachQuestionNumber ?? null,
    ),
  ]);

  return { turns, coachQuestion };
}
