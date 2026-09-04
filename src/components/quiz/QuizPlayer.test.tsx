// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuizPlayer } from "./QuizPlayer";

vi.mock("@/components/student/ExamResultsView", () => ({
  ExamResultsView: ({ attemptId }: { attemptId: string }) => (
    <div>Student results for {attemptId}</div>
  ),
}));

const questions = [
  {
    id: "single",
    text: "Pick one",
    answerMode: "SINGLE_SELECT",
    figureUrl: "/figure.png",
    figureAlt: "Question diagram",
    options: [
      {
        id: "s1",
        text: "Correct choice",
        isCorrect: true,
        imageUrl: "/choice.png",
        imageAlt: "Choice diagram",
      },
      { id: "s2", text: "Wrong choice", isCorrect: false },
    ],
  },
  {
    id: "multi",
    text: "Pick two",
    answerMode: "MULTI_SELECT",
    options: [
      { id: "m1", text: "Choice A", isCorrect: true },
      { id: "m2", text: "Choice B", isCorrect: true },
      { id: "m3", text: "Choice C", isCorrect: false },
    ],
  },
  {
    id: "numeric",
    text: "Enter a number",
    answerMode: "NUMERIC",
    answerNumeric: 10,
    answerTolerance: 0.5,
    answerUnit: "m",
    options: [],
  },
];

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ questions })));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(text: string) {
  const found = [...host.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === text || b.textContent?.trim() === `✓${text}`,
  );
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

async function enterNumber(value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountPreview() {
  await act(async () =>
    root.render(
      <StrictMode>
        <QuizPlayer
          mode="preview"
          quizId="quiz"
          backHref="/teacher/quizzes/quiz"
          backLabel="Back to quiz"
        />
      </StrictMode>,
    ),
  );
}

describe("QuizPlayer", () => {
  it("takes and restarts a preview with navigation, images, all answer types, and no submission requests", async () => {
    await mountPreview();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('img[alt="Question diagram"]')?.getAttribute("src"),
    ).toBe("/figure.png");
    expect(host.querySelector('img[alt="Choice diagram"]')).not.toBeNull();
    expect(button("Previous").disabled).toBe(true);
    await click("Wrong choice");
    await click("Next");
    expect(host.textContent).toContain("Select all that apply.");
    await click("Choice A");
    await click("Choice B");
    await click("Next");
    expect(button("Submit Quiz").disabled).toBe(true);
    await enterNumber("-");
    expect(button("Submit Quiz").disabled).toBe(true);
    await enterNumber("10.2");
    expect(button("Submit Quiz").disabled).toBe(false);
    await click("Previous");
    expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(
      2,
    );
    await click("Next");
    expect(host.querySelector("input")?.value).toBe("10.2");
    await click("Submit Quiz");
    expect(host.textContent).toContain("Preview results");
    expect(
      host.querySelector('svg[role="img"]')?.getAttribute("aria-label"),
    ).toContain("67 out of 100");
    expect(host.textContent).toContain("Wrong choice");
    expect(host.textContent).not.toContain("Correct choice");
    expect(host.textContent).not.toContain("Student results");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/teacher/quizzes/quiz",
    );

    await click("Restart preview");
    expect(host.textContent).toContain("0 answered");
    expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(
      0,
    );
    await click("3");
    expect(host.querySelector("input")?.value).toBe("");
    expect(button("Submit Quiz").disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/api/quizzes/quiz");
      expect(init).toEqual({ cache: "no-store" });
    }
  });

  it("shows read errors and retries without starting a student attempt", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Quiz not found" }), {
        status: 404,
      }),
    );
    await mountPreview();
    expect(host.textContent).toContain("Quiz not found");
    await click("Try again");
    expect(host.textContent).toContain("Pick one");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves student start, submission, and persisted-results behavior", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ attemptId: "attempt", questions: [questions[0]] }),
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ score: 100, incorrectQuestionIds: [] })),
    );
    await act(async () =>
      root.render(
        <StrictMode>
          <QuizPlayer
            mode="student"
            classId="class"
            quizId="quiz"
            backHref="/student/classes/class"
            backLabel="Back to class"
          />
        </StrictMode>,
      ),
    );
    await click("Correct choice");
    await click("Submit Quiz");
    expect(host.textContent).toContain("Student results for attempt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [[startUrl, start], [submitUrl, submit]] = fetchMock.mock.calls;
    expect(startUrl).toBe("/api/quiz");
    expect(start.method).toBe("POST");
    expect(JSON.parse(start.body)).toEqual({
      classId: "class",
      quizId: "quiz",
    });
    expect(submitUrl).toBe("/api/quiz");
    expect(submit.method).toBe("PATCH");
    expect(JSON.parse(submit.body)).toEqual({
      attemptId: "attempt",
      answers: [
        {
          questionId: "single",
          selectedOptionId: "s1",
          selectedOptionIds: ["s1"],
          numericValue: null,
        },
      ],
    });
  });
});
