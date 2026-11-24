// Fixed message catalog and structured fallback builder for Wrong Answer Coach.
// Every diagnosis-phase message is deterministic code-owned copy (PDF Section 3).

import type { StructuredTutoringMessage } from "./wrong-answer-coach-types";

export const COACH_PROTOCOL_REVISION = "1.0";
export const COACH_TUTORING_MAX_WORDS = 150;
export const COACH_MAX_EXPLANATION_CHARS = 2_000;
export const COACH_CHECK2_LOW_CONFIDENCE_THRESHOLD = 0.55;

export const COACH_FIXED_MESSAGES = {
  // Exact proposed wording from PDF Section 3 (pending final instructor confirmation):
  openingPrompt:
    "Let's look at this question together. How did you get your answer? Please explain your thinking in one or two sentences.",
  beforeSecondQuestion:
    "Thanks. Here is a similar question. Please choose the answer you think is right.",
  beforeHeldOutQuestion:
    "One more question on the same idea, and then I will go through it with you.",
  answerRequestRefusal:
    "I will go through the answer with you in a moment. First, please answer this question so I can understand your thinking.",

  // Safety & guidance copy (pending instructor & IRB sign-off):
  personalSupportRedirect:
    "It sounds like you may need support beyond this physics question. This chat assistant is only designed for quiz review — please reach out to your instructor or campus support services so a person can help you.",
  offTopicRedirect:
    "This chat assistant can only review this physics quiz question. We will move on to the next question now; please contact your instructor if you need help with something else.",
  offTopicMcqRedirect:
    "This chat assistant can only review this physics quiz question. Please choose one of the answer options above to continue, or contact your instructor if you need help with something else.",
  mcqPickChoicePrompt:
    "Please choose one of the answer options above to continue.",
} as const;

/**
 * Count words consistently across prompts, validators, and fallbacks.
 * Inline $...$ and display $$...$$ LaTeX blocks count as one word token each
 * so physics equations do not inflate word counts artificially.
 */
export function countCoachWords(text: string): number {
  const collapsed = text
    .replace(/\$\$[\s\S]*?\$\$/g, " MATH_TOKEN ")
    .replace(/\$[^$\n]+?\$/g, " MATH_TOKEN ")
    .trim();
  if (!collapsed) return 0;
  return collapsed.split(/\s+/).filter(Boolean).length;
}

/**
 * Render a StructuredTutoringMessage into its canonical plain-text string
 * stored in `WrongAnswerCoachSession.tutoringMessage` and transcript messages.
 */
export function formatStructuredTutoringPlainText(
  msg: StructuredTutoringMessage,
): string {
  const parts: string[] = [
    `The correct answer is: ${msg.correctAnswerText}.`,
    ...msg.bodyParagraphs.map((p) => p.trim()).filter(Boolean),
  ];
  if (msg.keyPoints && msg.keyPoints.length > 0) {
    parts.push(
      "Key ideas to remember:\n" +
        msg.keyPoints.map((kp) => `• ${kp.trim()}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

/**
 * Build the deterministic fallback tutoring message (used when Task B fails
 * validation twice or encounters an unrecovered provider error), strictly
 * respecting `maxWords` even when key points are verbose.
 */
export function buildTutoringFallbackMessage(input: {
  correctAnswerText: string;
  keyPoints: string[];
  maxWords?: number;
}): { structured: StructuredTutoringMessage; plainText: string } {
  const maxWords = input.maxWords ?? COACH_TUTORING_MAX_WORDS;
  const intro = "Review these key ideas from the course to see why:";
  const keptKeyPoints: string[] = [];

  for (const raw of input.keyPoints) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const candidate: StructuredTutoringMessage = {
      correctAnswerText: input.correctAnswerText,
      bodyParagraphs: [intro],
      keyPoints: [...keptKeyPoints, trimmed],
      usedFallback: true,
    };
    if (
      countCoachWords(formatStructuredTutoringPlainText(candidate)) <= maxWords
    ) {
      keptKeyPoints.push(trimmed);
      continue;
    }
    if (keptKeyPoints.length === 0) {
      // Binary-trim the first key point strictly within remaining budget.
      const tokens = trimmed.split(/\s+/);
      let fit = "";
      for (let len = tokens.length; len >= 1; len--) {
        const shortened = `${tokens.slice(0, len).join(" ")}…`;
        const probe: StructuredTutoringMessage = {
          correctAnswerText: input.correctAnswerText,
          bodyParagraphs: [intro],
          keyPoints: [shortened],
          usedFallback: true,
        };
        if (
          countCoachWords(formatStructuredTutoringPlainText(probe)) <= maxWords
        ) {
          fit = shortened;
          break;
        }
      }
      if (fit) keptKeyPoints.push(fit);
    }
    break;
  }

  const structured: StructuredTutoringMessage = {
    correctAnswerText: input.correctAnswerText,
    bodyParagraphs: keptKeyPoints.length > 0 ? [intro] : [],
    ...(keptKeyPoints.length > 0 ? { keyPoints: keptKeyPoints } : {}),
    usedFallback: true,
  };
  return {
    structured,
    plainText: formatStructuredTutoringPlainText(structured),
  };
}
