/**
 * Pure (Prisma-free) consent-form field helpers, shared by the client form
 * (src/components/consent/ConsentForm.tsx), request validation, the submit
 * route, and PDF rendering.
 */

/**
 * The interview-recording options on the approved forms ("Please check one
 * box below"). Picked only alongside an AGREE decision; a DECLINE leaves it
 * null. Superseded the older recording yes/no + drawn initials, which past
 * records still carry in interviewRecordingConsent / initialsStrokeData.
 */
export const INTERVIEW_RECORDING_CHOICES = [
  "VIDEO_AUDIO",
  "AUDIO_ONLY",
  "TRANSCRIPT_ONLY",
  "NO_INTERVIEW",
] as const;
export type InterviewRecordingChoice =
  (typeof INTERVIEW_RECORDING_CHOICES)[number];

/** Checkbox wording, verbatim from the approved forms. */
export const INTERVIEW_RECORDING_CHOICE_LABELS: Record<
  InterviewRecordingChoice,
  string
> = {
  VIDEO_AUDIO: "I agree to have my interview recorded with video and audio.",
  AUDIO_ONLY: "I agree to have my interview recorded with audio only.",
  TRANSCRIPT_ONLY:
    "I agree to have my interview transcribed, but do not consent to audio or video recording.",
  NO_INTERVIEW: "I do not want to participate in the interview.",
};

export function isInterviewRecordingChoice(
  value: unknown,
): value is InterviewRecordingChoice {
  return (
    typeof value === "string" &&
    (INTERVIEW_RECORDING_CHOICES as readonly string[]).includes(value)
  );
}

/**
 * Whether a choice permits any audio/video recording — kept in the legacy
 * interviewRecordingConsent column so older readers of that flag stay right.
 */
export function choiceAllowsRecording(
  choice: InterviewRecordingChoice,
): boolean {
  return choice === "VIDEO_AUDIO" || choice === "AUDIO_ONLY";
}

/**
 * UGA IDs are typed with or without dashes/spaces ("811-234-567"); store
 * digits only. Loose on length on purpose — rejecting a real ID would lock a
 * teacher out behind the consent gate.
 */
export function normalizeUgaId(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "");
  return /^\d{6,12}$/.test(digits) ? digits : null;
}
