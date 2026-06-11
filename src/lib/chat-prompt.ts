// Pure chat helpers, extracted from the chat route so the request-validation
// guard and the quiz-review prompt builder can be unit-tested without a server.

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Type guard: a value is a well-formed array of chat messages. */
export function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every((message) => {
      if (!message || typeof message !== "object") return false;
      const entry = message as { role?: unknown; content?: unknown };
      return (
        (entry.role === "system" || entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string"
      );
    })
  );
}

export type QuizReviewAttempt = {
  score: number | null;
  completedAt: Date | null;
  class: { name: string };
  quiz: { name: string; topic: { name: string } | null } | null;
  answers: Array<{
    isCorrect: boolean;
    selectedOption: { text: string } | null;
    // NUMERIC questions only: the student's submitted number (null when absent).
    numericValue?: number | null;
    question: {
      text: string;
      options: Array<{ text: string; isCorrect: boolean }>;
      // NUMERIC questions only (undefined / "SINGLE_SELECT"|"MULTI_SELECT" for
      // choice questions, which keep their option-based evidence lines):
      answerMode?: string;
      answerNumeric?: number | null;
      answerUnit?: string | null;
    };
  }>;
};

// $...$ LaTeX in question text, units, and option text is emitted RAW on purpose:
// the downstream chat/markdown renderer handles math, and the LLM reads it fine.
const withUnit = (value: string, unit: string | null | undefined): string =>
  unit ? `${value} ${unit}` : value;

/**
 * Build the LLM prompt that asks for a concise, three-section review of a
 * student's most recent completed quiz attempt. Includes per-question evidence
 * only for the answers the student got wrong.
 */
export function buildQuizReviewPrompt(attempt: QuizReviewAttempt): string {
  const incorrectAnswers = attempt.answers.filter((answer) => !answer.isCorrect);
  const correctAnswerCount = attempt.answers.length - incorrectAnswers.length;
  const lines = [
    "You are an educational assistant reviewing a student's latest completed quiz attempt.",
    "Write a concise markdown response directly to the student.",
    "Do not review the quiz question by question.",
    "Summarize the student's main misconceptions or learning gaps across the attempt.",
    "Use exactly three short sections titled Summary, Main Misconceptions, and Next Steps.",
    "Keep the full response under 120 words.",
    "Under Main Misconceptions, use at most 2 bullet points.",
    "Under Next Steps, use at most 2 bullet points.",
    "Only mention a specific question if it is essential evidence for a broader misconception.",
    "",
    `Class: ${attempt.class.name}`,
    ...(attempt.quiz?.topic ? [`Topic: ${attempt.quiz.topic.name}`] : []),
    `Quiz: ${attempt.quiz?.name ?? "Unknown"}`,
    `Score: ${attempt.score ?? 0}%`,
    `Completed at: ${attempt.completedAt?.toISOString() ?? "Unknown"}`,
    `Questions answered: ${attempt.answers.length}`,
    `Correct answers: ${correctAnswerCount}`,
    `Incorrect answers: ${incorrectAnswers.length}`,
    "",
    incorrectAnswers.length > 0
      ? "Evidence from incorrect answers:"
      : "The student answered every question correctly. Reinforce what they understood and suggest one useful next step.",
  ];

  incorrectAnswers.forEach((answer, index) => {
    // NUMERIC questions carry no options; show the student's submitted number
    // (or "No answer") and the correct number, each with the optional unit.
    // Choice questions keep their byte-identical option-based evidence lines.
    if (answer.question.answerMode === "NUMERIC") {
      const { numericValue } = answer;
      const studentAnswer =
        numericValue != null
          ? withUnit(String(numericValue), answer.question.answerUnit)
          : "No answer";
      const correctNumeric = answer.question.answerNumeric;
      const correctAnswer =
        correctNumeric != null
          ? withUnit(String(correctNumeric), answer.question.answerUnit)
          : "Unknown";

      lines.push(
        `${index + 1}. Question: ${answer.question.text}`,
        `   Student answer: ${studentAnswer}`,
        `   Correct answer: ${correctAnswer}`
      );
      return;
    }

    const correctOptions = answer.question.options.flatMap((option) =>
      option.isCorrect ? [option.text] : []
    );

    lines.push(
      `${index + 1}. Question: ${answer.question.text}`,
      `   Student selection: ${answer.selectedOption?.text ?? "No answer selected"}`,
      `   Correct answer: ${correctOptions.length > 0 ? correctOptions.join(" | ") : "Unknown"}`
    );
  });

  return lines.join("\n");
}
