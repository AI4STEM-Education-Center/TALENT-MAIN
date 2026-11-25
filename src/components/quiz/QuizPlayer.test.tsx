// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuizPlayer } from "./QuizPlayer";

vi.mock("@/components/student/ExamResultsView", () => ({
  ExamResultsView: ({
    attemptId,
    notice,
    actions,
  }: {
    attemptId: string;
    notice?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      Student results for {attemptId}
      <p>{notice}</p>
      {actions}
    </div>
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
  window.sessionStorage.clear();
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

describe("QuizPlayer resilience", () => {
  const mountStudent = () =>
    act(async () =>
      root.render(
        <QuizPlayer
          mode="student"
          classId="class"
          quizId="quiz"
          backHref="/student/classes/class"
          backLabel="Back to class"
        />,
      ),
    );
  const startResponse = () =>
    new Response(JSON.stringify({ attemptId: "attempt", questions }));

  it("explains an empty session instead of showing Question 1 of 0, and retries", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ attemptId: "attempt", questions: [] })),
    );
    fetchMock.mockResolvedValueOnce(startResponse());
    await mountStudent();
    expect(host.textContent).toContain("no questions available");
    expect(host.textContent).not.toContain("of 0");
    await click("Try again");
    expect(host.textContent).toContain("Question 1 of 3");
  });

  it("keeps answers in progress when the student leaves and continues the same attempt", async () => {
    fetchMock.mockImplementation(async () => startResponse());
    await mountStudent();
    await click("Wrong choice");
    await click("Next");
    await click("Choice A");
    await click("Next");
    await enterNumber("9.5");

    // "Quiz options" unmounts the player; "Continue" mounts a fresh one that
    // resumes the same attempt.
    await act(async () => root.unmount());
    root = createRoot(host);
    await mountStudent();
    expect(host.textContent).toContain("Question 3 of 3");
    expect(host.querySelector("input")?.value).toBe("9.5");
    expect(host.textContent).toContain("3 answered");
    await click("1");
    expect(button("Wrong choice").getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(
      1,
    );
  });

  it("forgets the draft once the attempt is submitted", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ attemptId: "attempt", questions: [questions[0]] }),
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ score: 100, incorrectQuestionIds: [] })),
    );
    await mountStudent();
    await click("Correct choice");
    expect(window.sessionStorage.getItem("quiz-draft:attempt")).not.toBeNull();
    await click("Submit Quiz");
    expect(window.sessionStorage.getItem("quiz-draft:attempt")).toBeNull();
  });

  it("ignores a corrupt draft", async () => {
    window.sessionStorage.setItem("quiz-draft:attempt", "{not json");
    fetchMock.mockImplementation(async () => startResponse());
    await mountStudent();
    expect(host.textContent).toContain("Question 1 of 3");
    expect(host.textContent).toContain("0 answered");
  });
});

describe("alternative practice player", () => {
  it("records a retake, shows the standard results and recommendations, and returns to practice options", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          attemptId: "practice-1",
          quizAttemptId: "attempt-1",
          versionName: "Version A",
          excludedCount: 2,
          exclusionIgnored: false,
          questions: [questions[0]],
        }),
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          score: 100,
          quizAttemptId: "attempt-1",
          incorrectQuestionIds: [],
        }),
      ),
    );
    const onPracticeAgain = vi.fn();
    await act(async () =>
      root.render(
        <StrictMode>
          <QuizPlayer
            mode="practice"
            classId="class"
            quizId="quiz"
            excludeCorrect
            onPracticeAgain={onPracticeAgain}
            backHref="/student/classes/class"
            backLabel="Back to class"
          />
        </StrictMode>,
      ),
    );
    expect(host.textContent).toContain("Version A · Alternative version");
    expect(host.textContent).toContain("Recorded as a retake");
    expect(host.textContent).toContain(
      "2 questions you answered correctly before are left out",
    );
    await click("Correct choice");
    await click("Submit Quiz");
    // Same results view (summary + recommendations) as an ordinary attempt,
    // keyed by the recorded QuizAttempt rather than the practice id.
    expect(host.textContent).toContain("Student results for attempt-1");
    expect(host.textContent).toContain(
      "Alternative version: Version A. Recorded as a retake",
    );
    await click("Practice another version");
    expect(onPracticeAgain).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/quiz/practice",
      "/api/quiz/practice",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      classId: "class",
      quizId: "quiz",
      excludeCorrect: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      attemptId: "practice-1",
    });
  });
});

describe("official quiz exclusions", () => {
  it("starts with the chosen exclusions, says so during the quiz, and notes it on results", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          attemptId: "attempt",
          excludedCount: 2,
          exclusionIgnored: false,
          questions: [questions[0]],
        }),
      ),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ score: 100, incorrectQuestionIds: [] })),
    );
    const onBackToSetup = vi.fn();
    await act(async () =>
      root.render(
        <QuizPlayer
          mode="student"
          classId="class"
          quizId="quiz"
          exclusionOptions={{ excludedQuestionIds: ["x", "y"] }}
          onBackToSetup={onBackToSetup}
          backHref="/student/classes/class"
          backLabel="Back to class"
        />,
      ),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      classId: "class",
      quizId: "quiz",
      excludedQuestionIds: ["x", "y"],
    });
    expect(host.textContent).toContain(
      "2 questions you answered correctly before are left out",
    );
    await click("Correct choice");
    await click("Submit Quiz");
    expect(host.textContent).toContain(
      "2 questions you answered correctly before were left out. This attempt's score covers the remaining questions.",
    );
    await click("Retake quiz");
    expect(onBackToSetup).toHaveBeenCalledWith("official");
    await click("Practice another version");
    expect(onBackToSetup).toHaveBeenLastCalledWith("practice");
  });
});
