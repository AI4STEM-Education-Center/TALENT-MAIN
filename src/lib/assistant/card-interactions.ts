import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseStoredRecommendations } from "@/lib/exam-results";
import {
  coachActionRefSchema,
  CARD_SUMMARY_MAX,
  resolveCoachScope,
} from "./coach";
import {
  findCoachConversation,
  historyCutoff,
  isFinalCoachTranscript,
  MAX_TRANSCRIPT_TURNS,
  type ConversationTarget,
} from "./conversation-store";
import {
  studyActionRefSchema,
  type StudyActionRef,
} from "./study-recommendations";

export const cardTargetFields = {
  conversationId: z.string().min(1).max(64).optional(),
  attemptId: z.string().min(1).max(64).optional(),
  questionNumber: z.number().int().min(1).max(500).optional(),
  cardId: z.uuid().optional(),
};

type CardTarget = {
  conversationId?: string;
  attemptId?: string;
  questionNumber?: number;
};

type CardRef = z.infer<typeof coachActionRefSchema>;

type CardEntry = {
  ref: CardRef;
  study?: StudyActionRef;
  resultId: string | null;
  questionNumber: number | null;
};

export async function findStoredCard(
  owner: ConversationTarget & { studentId: string },
  retentionDays: number,
  target: CardTarget,
  matches: (card: CardEntry) => boolean | Promise<boolean>,
) {
  const { studentId, ...conversationOwner } = owner;
  const { conversationId, attemptId, questionNumber } = target;
  let id = conversationId;
  if (!id && attemptId && questionNumber) {
    const scope = await resolveCoachScope(studentId, attemptId, questionNumber);
    if (scope)
      id = (
        await findCoachConversation(conversationOwner, scope, retentionDays)
      )?.id;
  }
  if (!id) return null;
  const conversation = await prisma.assistantConversation.findFirst({
    where: {
      ...conversationOwner,
      id,
      archivedAt: null,
      lastMessageAt: { gte: historyCutoff(retentionDays) },
    },
    select: {
      id: true,
      coachResultId: true,
      coachQuestionNumber: true,
      coachActiveKey: true,
    },
  });
  if (!conversation) return null;
  if (
    conversation.coachResultId &&
    conversation.coachQuestionNumber &&
    isFinalCoachTranscript(conversationOwner, conversation)
  ) {
    const scope = await resolveCoachScope(
      studentId,
      conversation.coachResultId,
      conversation.coachQuestionNumber,
    );
    if (!scope?.answerKeyAvailable) return null;
  }

  const messages = await prisma.assistantMessage.findMany({
    where: {
      conversationId: conversation.id,
      role: "assistant",
      actions: { not: "[]" },
    },
    select: { id: true, actions: true },
    orderBy: { seq: "desc" },
    take: MAX_TRANSCRIPT_TURNS,
  });
  for (const message of messages) {
    let actions: unknown;
    try {
      actions = JSON.parse(message.actions);
    } catch {
      continue;
    }
    if (!Array.isArray(actions)) continue;
    for (let index = actions.length - 1; index >= 0; index--) {
      const study = studyActionRefSchema.safeParse(actions[index]);
      const coach = coachActionRefSchema.safeParse(actions[index]);
      const entry =
        conversation.coachResultId && coach.success
          ? {
              ref: coach.data,
              resultId: conversation.coachResultId,
              questionNumber: conversation.coachQuestionNumber,
            }
          : !conversation.coachResultId && study.success
            ? {
                ref: study.data.ref,
                study: study.data,
                resultId: study.data.resultId ?? null,
                questionNumber: study.data.questionNumber ?? null,
              }
            : null;
      if (!entry || !(await matches(entry))) continue;
      return { ...entry, message, actions, index };
    }
  }
  return null;
}

type StoredCard = NonNullable<Awaited<ReturnType<typeof findStoredCard>>>;

/** Compare the original JSON before replacing it to preserve concurrent card updates. */
export async function writeStoredCard(
  db: Pick<Prisma.TransactionClient, "assistantMessage">,
  card: StoredCard,
  ref: CardRef,
) {
  const actions = card.actions.slice();
  actions[card.index] = card.study ? { ...card.study, ref } : ref;
  const updated = await db.assistantMessage.updateMany({
    where: { id: card.message.id, actions: card.message.actions },
    data: { actions: JSON.stringify(actions) },
  });
  return updated.count === 1;
}

const summary = z.string().trim().min(1).max(CARD_SUMMARY_MAX).optional();
export const cardInteractionSchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...cardTargetFields,
      kind: z.literal("material"),
      recommendationIndex: z.number().int().min(0).max(50).optional(),
      materialId: z.string().min(1).max(64).optional(),
      summary,
    }),
    z.object({
      ...cardTargetFields,
      kind: z.literal("simulation"),
      simulationId: z.string().min(1).max(64).optional(),
      summary,
    }),
    z.object({
      ...cardTargetFields,
      kind: z.literal("diagnostic_options"),
      selectedOptionId: z.string().trim().min(1).max(64).optional(),
      selectedLabel: z.string().trim().min(1).max(160).optional(),
    }),
  ])
  .superRefine((input, ctx) => {
    const requireField = (ok: unknown, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    requireField(
      input.conversationId || (input.attemptId && input.questionNumber),
      "Conversation or quiz attempt and question required.",
    );
    if (input.kind === "material") {
      requireField(
        input.cardId ||
          input.materialId ||
          input.recommendationIndex !== undefined,
        "Material card required.",
      );
    } else if (input.kind === "simulation") {
      requireField(
        input.cardId || input.simulationId,
        "Simulation card required.",
      );
    } else {
      requireField(
        input.selectedOptionId || input.selectedLabel,
        "Diagnostic option required.",
      );
    }
  });

export async function saveCardInteraction(
  owner: ConversationTarget & { studentId: string },
  retentionDays: number,
  input: z.infer<typeof cardInteractionSchema>,
) {
  const { userId, audience, studentId } = owner;
  const now = new Date().toISOString();
  const matches = async ({ ref, resultId, questionNumber }: CardEntry) => {
    if (
      ref.kind !== input.kind ||
      (input.cardId && input.cardId !== ref.cardId)
    )
      return false;
    if (input.attemptId && input.attemptId !== resultId) return false;
    if (input.questionNumber && input.questionNumber !== questionNumber)
      return false;
    if (input.kind === "simulation" && ref.kind === "simulation") {
      return !input.simulationId || input.simulationId === ref.simulationId;
    }
    if (input.kind === "material" && ref.kind === "material") {
      if (
        input.recommendationIndex !== undefined &&
        input.recommendationIndex !== ref.recommendationIndex
      )
        return false;
      if (
        !input.materialId ||
        input.cardId ||
        input.recommendationIndex !== undefined
      )
        return true;
      const result =
        resultId &&
        (await prisma.examResult.findFirst({
          where: { quizAttemptId: resultId, studentId },
          select: { recommendations: true },
        }));
      if (!result) return false;
      const recommendation = parseStoredRecommendations(result.recommendations)
        .items[ref.recommendationIndex];
      if (!recommendation) return false;
      if (recommendation.materialId)
        return recommendation.materialId === input.materialId;
      // Older result snapshots identify the recommended material by its pages.
      const page = await prisma.materialPage.findFirst({
        where: {
          materialId: input.materialId,
          storageKey: {
            in: recommendation.pages.map((item) => item.storageKey),
          },
        },
        select: { id: true },
      });
      return !!page;
    }
    return (
      input.kind === "diagnostic_options" &&
      ref.kind === "diagnostic_options" &&
      ref.options.some((option) =>
        input.selectedOptionId
          ? option.id === input.selectedOptionId
          : option.label === input.selectedLabel,
      )
    );
  };

  for (let retry = 0; retry < 3; retry++) {
    const card = await findStoredCard(
      { userId, audience, studentId },
      retentionDays,
      input,
      matches,
    );
    if (!card) return null;
    const ref = card.ref;
    let updated: CardRef;
    if (ref.kind === "simulation" && input.kind === "simulation") {
      updated = {
        ...ref,
        interaction: {
          status: "opened",
          openedAt: ref.interaction?.openedAt ?? now,
          lastInteractedAt: now,
          summary: input.summary ?? ref.interaction?.summary,
        },
      };
    } else if (ref.kind === "material" && input.kind === "material") {
      updated = {
        ...ref,
        interaction: {
          status: "viewed",
          viewedAt: ref.interaction?.viewedAt ?? now,
          summary: input.summary ?? ref.interaction?.summary,
        },
      };
    } else if (
      ref.kind === "diagnostic_options" &&
      input.kind === "diagnostic_options"
    ) {
      const selected = ref.options.find((option) =>
        input.selectedOptionId
          ? option.id === input.selectedOptionId
          : option.label === input.selectedLabel,
      );
      if (!selected) return null;
      updated = {
        ...ref,
        interaction: {
          status: "selected",
          selectedOptionId: selected.id,
          selectedLabel: selected.label,
          selectedAt: now,
        },
      };
    } else {
      return null;
    }
    if (await writeStoredCard(prisma, card, updated))
      return updated.interaction;
  }
  return null;
}
