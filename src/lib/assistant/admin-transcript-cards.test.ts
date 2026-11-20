import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  examResultFindMany,
  learningMaterialFindMany,
  quizPracticeVersionFindMany,
  questionSimulationFindMany,
  questionFindUnique,
  signObjectReadUrl,
  getS3Config,
} = vi.hoisted(() => ({
  examResultFindMany: vi.fn(),
  learningMaterialFindMany: vi.fn(),
  quizPracticeVersionFindMany: vi.fn(),
  questionSimulationFindMany: vi.fn(),
  questionFindUnique: vi.fn(),
  signObjectReadUrl: vi.fn(),
  getS3Config: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    examResult: { findMany: examResultFindMany },
    learningMaterial: { findMany: learningMaterialFindMany },
    quizPracticeVersion: { findMany: quizPracticeVersionFindMany },
    questionSimulation: { findMany: questionSimulationFindMany },
    question: { findUnique: questionFindUnique },
  },
}));

vi.mock("@/lib/storage", () => ({
  signObjectReadUrl,
  getS3Config,
}));

vi.mock("@/lib/question-figures", () => ({
  presignQuestionFigure: vi.fn().mockResolvedValue(null),
  presignOptionImage: vi.fn().mockResolvedValue(null),
}));

import { hydrateAdminTranscript } from "./admin-transcript-cards";

describe("hydrateAdminTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    examResultFindMany.mockResolvedValue([]);
    learningMaterialFindMany.mockResolvedValue([]);
    quizPracticeVersionFindMany.mockResolvedValue([]);
    questionSimulationFindMany.mockResolvedValue([]);
    questionFindUnique.mockResolvedValue(null);
    getS3Config.mockReturnValue({ bucket: "default-bucket" });
    signObjectReadUrl.mockImplementation(
      async (bucket: string, key: string) =>
        `https://signed.test/${bucket}/${key}`,
    );
  });

  it("hydrates course materials, diagnostic options, practice questions with options/key, simulations, and the original coach question", async () => {
    examResultFindMany.mockResolvedValue([
      {
        quizAttemptId: "attempt-1",
        studentId: "student-1",
        classId: "class-1",
        quizId: "quiz-1",
        quizName: "Newton's Laws",
        topicName: "Forces",
        className: "Physics 101",
        practiceVersionName: null,
        reviewSnapshot: JSON.stringify({
          questions: [
            {
              questionId: "q-1",
              text: "Question 1",
              isCorrect: true,
              options: [],
            },
            {
              questionId: "q-2",
              text: "Which forces form a third-law pair?",
              isCorrect: false,
              answerMode: "SINGLE_SELECT",
              options: [
                {
                  text: "Gravity and normal",
                  isCorrect: false,
                  selected: true,
                },
                {
                  text: "Seat on person and person on seat",
                  isCorrect: true,
                  selected: false,
                },
              ],
            },
          ],
        }),
        recommendations: JSON.stringify({
          items: [
            {
              materialId: "mat-1",
              materialTitle: "Old Title",
              pageRange: { start: 4, end: 5 },
              reason: "Explains third-law pairs.",
              pages: [
                { pageNumber: 4, storageKey: "materials/mat-1/p4.png" },
                { pageNumber: 5, storageKey: "materials/mat-1/p5.png" },
              ],
            },
          ],
          truncated: false,
        }),
      },
    ]);

    learningMaterialFindMany.mockResolvedValue([
      {
        id: "mat-1",
        title: "Newton's Third Law Notes",
        originalName: "ch4.pdf",
        bucket: "materials-bucket",
        pages: [
          { pageNumber: 4, storageKey: "materials/mat-1/p4.png" },
          { pageNumber: 5, storageKey: "materials/mat-1/p5.png" },
        ],
      },
    ]);

    quizPracticeVersionFindMany.mockResolvedValue([
      {
        id: "ver-1",
        name: "Alternative A",
        questions: JSON.stringify([
          {
            id: "vq-1",
            sourceQuestionId: "q-2",
            text: "A performer stands on a rising stage lift.",
            answerMode: "SINGLE_SELECT",
            answerUnit: null,
            answerNumeric: null,
            answerTolerance: null,
            options: [
              { id: "opt-a", text: "Floor force is larger.", isCorrect: false },
              {
                id: "opt-b",
                text: "Forces are equal and opposite.",
                isCorrect: true,
              },
            ],
            solution: "Third law always holds.",
            intentExplanation: "Tests force-pair invariance.",
          },
        ]),
      },
    ]);

    questionSimulationFindMany.mockResolvedValue([
      {
        id: "sim-1",
        title: "Lift Force Pair Lab",
        topic: "Newton's Laws",
        bucket: "sims-bucket",
        learningGoal:
          "See how acceleration affects net force vs action-reaction.",
        version: 3,
        status: "READY",
        storageKey: "sims/sim-1/v3.html",
      },
    ]);

    const result = await hydrateAdminTranscript({
      coachResultId: "attempt-1",
      coachQuestionNumber: 2,
      turns: [
        {
          role: "assistant",
          content: "Here is a reading and a check.",
          actions: [
            {
              cardId: "c-mat",
              kind: "material",
              recommendationIndex: 0,
              reason: "Review force pairs.",
              interaction: {
                status: "viewed",
                viewedAt: "2026-11-20T00:00:00Z",
              },
            },
            {
              cardId: "c-diag",
              kind: "diagnostic_options",
              prompt: "Which step next?",
              options: [
                { id: "d1", label: "Identify the two objects" },
                { id: "d2", label: "Compare force magnitudes" },
              ],
              interaction: {
                status: "selected",
                selectedOptionId: "d1",
                selectedLabel: "Identify the two objects",
                selectedAt: "2026-11-20T00:00:00Z",
              },
            },
          ],
        },
        {
          role: "user",
          content: "Give me a practice question.",
        },
        {
          role: "assistant",
          content: "Try this one and the lab.",
          actions: [
            {
              cardId: "c-prac",
              kind: "practice",
              versionId: "ver-1",
              variantQuestionId: "vq-1",
              reason: "Same concept, new scenario.",
              interaction: {
                status: "completed",
                selectedOptionId: "opt-b",
                selectedText: "Forces are equal and opposite.",
                numericValue: null,
                correct: true,
                completedAt: "2026-11-20T00:01:00Z",
              },
            },
            {
              cardId: "c-sim",
              kind: "simulation",
              simulationId: "sim-1",
              goal: "Test upward acceleration",
              steps: ["Increase a", "Compare arrows"],
              observe: "Pair arrows remain equal.",
            },
          ],
        },
      ],
    });

    // Original coach question hydrated with full admin review/answer key
    expect(result.coachQuestion).not.toBeNull();
    expect(result.coachQuestion?.questionNumber).toBe(2);
    expect(result.coachQuestion?.review?.choices).toHaveLength(2);
    expect(result.coachQuestion?.review?.choices[1]?.correct).toBe(true);

    // Turn 1: material + diagnostic_options
    const turn0Cards = result.turns[0].cards ?? [];
    expect(turn0Cards).toHaveLength(2);
    expect(turn0Cards[0]).toMatchObject({
      kind: "material",
      recommendation: {
        materialId: "mat-1",
        materialTitle: "Newton's Third Law Notes",
        pageRange: { start: 4, end: 5 },
        pages: [
          {
            pageNumber: 4,
            imageUrl:
              "https://signed.test/materials-bucket/materials/mat-1/p4.png",
          },
          {
            pageNumber: 5,
            imageUrl:
              "https://signed.test/materials-bucket/materials/mat-1/p5.png",
          },
        ],
      },
    });
    expect(turn0Cards[1]).toMatchObject({
      kind: "diagnostic_options",
      prompt: "Which step next?",
      options: [
        { id: "d1", label: "Identify the two objects" },
        { id: "d2", label: "Compare force magnitudes" },
      ],
    });

    // Turn 3: practice (with all options + isCorrect) + simulation
    const turn2Cards = result.turns[2].cards ?? [];
    expect(turn2Cards).toHaveLength(2);
    expect(turn2Cards[0]).toMatchObject({
      kind: "practice",
      question: {
        versionId: "ver-1",
        versionName: "Alternative A",
        questionId: "vq-1",
        text: "A performer stands on a rising stage lift.",
        answerMode: "SINGLE_SELECT",
      },
    });
    if (turn2Cards[0].kind === "practice") {
      expect(turn2Cards[0].question?.options).toHaveLength(2);
      expect(
        turn2Cards[0].question?.options.find((o) => o.id === "opt-b")
          ?.isCorrect,
      ).toBe(true);
    }
    expect(turn2Cards[1]).toMatchObject({
      kind: "simulation",
      simulation: {
        simulationId: "sim-1",
        title: "Lift Force Pair Lab",
        version: 3,
        playable: true,
      },
    });

    // Batched DB access: each table queried at most once
    expect(examResultFindMany).toHaveBeenCalledTimes(1);
    expect(learningMaterialFindMany).toHaveBeenCalledTimes(1);
    expect(quizPracticeVersionFindMany).toHaveBeenCalledTimes(1);
    expect(questionSimulationFindMany).toHaveBeenCalledTimes(1);

    // Explicit allowlist: raw actions, attachmentIds, internal solution text,
    // intent explanation, and simulation storage keys are never serialized.
    expect(result.turns[0]).not.toHaveProperty("actions");
    expect(result.turns[0]).not.toHaveProperty("attachmentIds");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Third law always holds.");
    expect(serialized).not.toContain("Tests force-pair invariance.");
    expect(serialized).not.toContain("sims/sim-1/v3.html");
  });

  it("isolates malformed recommendations, failed resource queries, and non-READY simulations", async () => {
    examResultFindMany.mockResolvedValue([
      {
        quizAttemptId: "attempt-3",
        studentId: "student-1",
        classId: "class-1",
        quizId: "quiz-1",
        quizName: "Quiz 3",
        topicName: "Energy",
        className: "Physics",
        practiceVersionName: null,
        reviewSnapshot: "{}",
        recommendations: JSON.stringify({
          items: [
            // Malformed entry at index 0 (missing pages array) must not crash or shift index 1
            { materialTitle: "Broken", pageRange: { start: 1, end: 1 } },
            {
              materialId: "mat-2",
              materialTitle: "Energy Notes",
              pageRange: { start: 2, end: 3 },
              reason: "Work-energy theorem.",
              pages: [{ pageNumber: 2, storageKey: "mat-2/p2.png" }],
            },
          ],
          truncated: false,
        }),
      },
    ]);
    learningMaterialFindMany.mockResolvedValue([
      {
        id: "mat-2",
        title: "Energy Notes",
        originalName: "energy.pdf",
        bucket: "mat-bucket",
        pages: [{ pageNumber: 2, storageKey: "mat-2/p2.png" }],
      },
    ]);
    quizPracticeVersionFindMany.mockRejectedValue(new Error("DB timeout"));
    questionSimulationFindMany.mockResolvedValue([
      {
        id: "sim-draft",
        title: "Draft Sim",
        topic: "Energy",
        learningGoal: null,
        version: 1,
        status: "DRAFT",
        bucket: "sims-bucket",
        storageKey: "sims/draft.html",
      },
      {
        id: "sim-nobucket",
        title: "Missing Bucket Sim",
        topic: "Energy",
        learningGoal: null,
        version: 1,
        status: "READY",
        bucket: null,
        storageKey: "sims/nobucket.html",
      },
    ]);

    const result = await hydrateAdminTranscript({
      coachResultId: "attempt-3",
      coachQuestionNumber: 1,
      turns: [
        {
          role: "assistant",
          content: "Review these.",
          attachmentIds: ["secret-att-id"],
          attachmentNames: [
            "diagram.png",
            { leaked: "object-entry" } as unknown as string,
          ],
          actions: [
            { kind: "material", recommendationIndex: 0, reason: "Broken one" },
            { kind: "material", recommendationIndex: 1, reason: "Good one" },
            {
              kind: "practice",
              versionId: "ver-x",
              variantQuestionId: "vq-x",
              reason: "Practice",
              questionText: "Fallback text",
            },
            {
              kind: "simulation",
              simulationId: "sim-draft",
              goal: "Try draft",
              steps: ["Step 1"],
              observe: "Watch",
            },
            {
              kind: "simulation",
              simulationId: "sim-nobucket",
              goal: "Try missing bucket",
              steps: ["Step 1"],
              observe: "Watch",
            },
          ],
        },
      ],
    });

    const cards = result.turns[0].cards ?? [];
    expect(cards).toHaveLength(5);
    expect(cards[0]).toMatchObject({ kind: "material", recommendation: null });
    expect(cards[1]).toMatchObject({
      kind: "material",
      recommendation: {
        materialTitle: "Energy Notes",
        pages: [{ pageNumber: 2 }],
      },
    });
    expect(cards[2]).toMatchObject({
      kind: "practice",
      question: null,
      questionText: "Fallback text",
    });
    expect(cards[3]).toMatchObject({
      kind: "simulation",
      simulation: { title: "Draft Sim", playable: false },
    });
    expect(cards[4]).toMatchObject({
      kind: "simulation",
      simulation: { title: "Missing Bucket Sim", playable: false },
    });
    expect(result.turns[0].attachmentNames).toEqual(["diagram.png"]);
    expect(JSON.stringify(result)).not.toContain("secret-att-id");
    expect(JSON.stringify(result)).not.toContain("object-entry");
  });

  it("degrades gracefully when underlying DB rows were deleted or S3 is unavailable", async () => {
    getS3Config.mockImplementation(() => {
      throw new Error("S3 not configured");
    });
    examResultFindMany.mockResolvedValue([
      {
        quizAttemptId: "attempt-2",
        studentId: "student-1",
        classId: "class-1",
        quizId: "quiz-1",
        quizName: "Quiz 2",
        topicName: "Kinematics",
        className: "Physics",
        practiceVersionName: null,
        reviewSnapshot: "{}",
        recommendations: JSON.stringify({
          items: [
            {
              materialId: "deleted-mat",
              materialTitle: "Archived Notes",
              pageRange: { start: 1, end: 2 },
              reason: "Still readable title.",
              pages: [{ pageNumber: 1, storageKey: "gone/p1.png" }],
            },
          ],
          truncated: false,
        }),
      },
    ]);

    const result = await hydrateAdminTranscript({
      coachResultId: null,
      coachQuestionNumber: null,
      turns: [
        {
          role: "assistant",
          content: "Study helper turn",
          actions: [
            {
              source: "study",
              resultId: "attempt-2",
              ref: {
                kind: "material",
                recommendationIndex: 0,
                reason: "Read pages 1-2",
              },
            },
            {
              source: "study",
              ref: {
                kind: "practice",
                versionId: "deleted-ver",
                variantQuestionId: "vq-gone",
                reason: "Try practice",
                questionText: "Fallback prompt",
              },
            },
          ],
        },
      ],
    });

    expect(result.coachQuestion).toBeNull();
    const cards = result.turns[0].cards ?? [];
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      kind: "material",
      recommendation: {
        materialTitle: "Archived Notes",
        pageRange: { start: 1, end: 2 },
        pages: [],
      },
    });
    expect(cards[1]).toMatchObject({
      kind: "practice",
      questionText: "Fallback prompt",
      question: null,
    });
  });
});
