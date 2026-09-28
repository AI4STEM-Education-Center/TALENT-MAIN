// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({
  useConfirm: () => async () => true,
}));
vi.mock("./quiz-editor-load", () => ({ loadQuizEditorData: vi.fn() }));
import { loadQuizEditorData } from "./quiz-editor-load";
import { useQuizEditor, type QuizEditorModel } from "./use-quiz-editor";
import type { QuizDetail } from "./quiz-editor-types";

const quiz: QuizDetail = {
  id: "quiz",
  name: "Quiz",
  topicId: null,
  topic: null,
  teacherId: "teacher",
  editable: true,
  questions: [
    {
      id: "question",
      text: "Prompt",
      difficultyLevel: "BEGINNER",
      answerMode: "SINGLE_SELECT",
      options: [
        { id: "a", text: "A", isCorrect: true },
        { id: "b", text: "B", isCorrect: false },
      ],
    },
  ],
};
let cleanup: () => void;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.mocked(loadQuizEditorData).mockResolvedValue({
    kind: "ok",
    quiz,
    topics: [],
  });
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});
async function mount() {
  let current: QuizEditorModel;
  function Harness() {
    current = useQuizEditor("quiz");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  cleanup = () => act(() => root.unmount());
  return {
    get current() {
      return current!;
    },
  };
}

describe("quiz editor mutations", () => {
  it.each([403, 500])(
    "retains a question when deletion fails with HTTP %s",
    async (status) => {
      const state = await mount();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      await act(async () => state.current.deleteQuestion("question"));
      expect(state.current.quiz?.questions).toHaveLength(1);
      expect(state.current.msg).toMatch(/Could not delete/);
    },
  );
  it("reports network failures without dropping the unsaved question form", async () => {
    const state = await mount();
    await act(async () => state.current.startEdit(quiz.questions[0]));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
    await act(async () => state.current.saveQuestion());
    expect(state.current.editingQuestion?.id).toBe("question");
    expect(state.current.msg).toMatch(/Could not save/);
    expect(state.current.savingQuestion).toBe(false);
  });
  it("allows only one save until the pending request finishes", async () => {
    const state = await mount();
    await act(async () => state.current.startEdit(quiz.questions[0]));
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    let pending!: Promise<void>;
    await act(async () => {
      pending = state.current.saveQuestion();
    });
    await act(async () => state.current.saveQuestion());
    expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => {
      resolve(Response.json({ error: "Try again" }, { status: 503 }));
      await pending;
    });
    expect(state.current.savingQuestion).toBe(false);
  });
});

describe("question reordering", () => {
  const second = { ...quiz.questions[0], id: "second", text: "Second" };
  const twoQuestions: QuizDetail = {
    ...quiz,
    questions: [quiz.questions[0], second],
  };
  const order = (state: { current: QuizEditorModel }) =>
    state.current.quiz?.questions.map((q) => q.id);
  beforeEach(() => {
    vi.mocked(loadQuizEditorData).mockResolvedValue({
      kind: "ok",
      quiz: twoQuestions,
      topics: [],
    });
  });

  it("moves a question and saves the full new order", async () => {
    const state = await mount();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", fetcher);
    await act(async () => state.current.moveQuestion("second", -1));
    expect(order(state)).toEqual(["second", "question"]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/quizzes/quiz/question-order",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ questionIds: ["second", "question"] }),
      }),
    );
  });

  it("rolls back and reports when the save is rejected", async () => {
    const state = await mount();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ error: "List changed" }, { status: 409 }),
        )
        .mockResolvedValueOnce(Response.json(twoQuestions)),
    );
    await act(async () => state.current.moveQuestion("question", 1));
    expect(order(state)).toEqual(["question", "second"]);
    expect(state.current.msg).toBe("List changed");
    expect(state.current.reorderBusy).toBe(false);
  });
});
