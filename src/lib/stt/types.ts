// Provider-agnostic Speech-to-Text (STT) types, state machine states, and
// admin-configurable settings.
//
// The initial provider is Amazon Transcribe Streaming over a direct browser-to-AWS
// SigV4-presigned WebSocket so zero audio bytes or ML models ever run on the
// EC2 host. Additional providers (Cloudflare Workers AI, OpenAI Realtime,
// self-hosted Whisper) can implement `SttProvider` without touching the UI.

export const STT_PROVIDERS = ["aws_transcribe"] as const;
export type SttProviderId = (typeof STT_PROVIDERS)[number];

export const STT_PARTIAL_STABILITIES = ["high", "medium", "low"] as const;
export type SttPartialStability = (typeof STT_PARTIAL_STABILITIES)[number];

export function isSttPartialStability(
  value: unknown,
): value is SttPartialStability {
  return (
    typeof value === "string" &&
    (STT_PARTIAL_STABILITIES as readonly string[]).includes(value)
  );
}

/**
 * Languages supported by Amazon Transcribe Streaming over WebSocket.
 * Kept as a curated catalog for the admin UI, while still validating against
 * known streaming language codes.
 */
export const STT_LANGUAGES = [
  { code: "en-US", label: "English (US)" },
  { code: "zh-CN", label: "Chinese, Mandarin (Simplified, zh-CN)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "es-US", label: "Spanish (US)" },
  { code: "fr-FR", label: "French (FR)" },
  { code: "de-DE", label: "German (DE)" },
  { code: "ja-JP", label: "Japanese (ja-JP)" },
  { code: "ko-KR", label: "Korean (ko-KR)" },
  { code: "pt-BR", label: "Portuguese (BR)" },
  { code: "hi-IN", label: "Hindi (hi-IN)" },
] as const;

export type SttLanguageCode = (typeof STT_LANGUAGES)[number]["code"];

export const STT_LANGUAGE_CODES: readonly SttLanguageCode[] = STT_LANGUAGES.map(
  (l) => l.code,
);

export function isSttLanguageCode(value: unknown): value is SttLanguageCode {
  return (
    typeof value === "string" &&
    (STT_LANGUAGE_CODES as readonly string[]).includes(value)
  );
}

/**
 * AWS regions where Amazon Transcribe Streaming WebSocket endpoint
 * (`wss://transcribestreaming.<region>.amazonaws.com:8443`) is available.
 */
export const AWS_TRANSCRIBE_STREAMING_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "sa-east-1",
] as const;

export type AwsTranscribeRegion =
  (typeof AWS_TRANSCRIBE_STREAMING_REGIONS)[number];

export function isAwsTranscribeRegion(
  value: unknown,
): value is AwsTranscribeRegion {
  return (
    typeof value === "string" &&
    (AWS_TRANSCRIBE_STREAMING_REGIONS as readonly string[]).includes(value)
  );
}

/**
 * Admin-configurable STT settings stored inside `AssistantConfig`.
 */
export interface SttSettings {
  enabled: boolean;
  provider: SttProviderId;
  /** Empty string = fall back to deployment `AWS_REGION`. */
  region: string;
  languageCode: SttLanguageCode;
  /**
   * When true, Amazon Transcribe Streaming uses automatic language
   * identification (`identify-language=true`) across `languageOptions` instead
   * of pinning a single `language-code`.
   */
  identifyLanguage: boolean;
  /** At least 2 language codes when `identifyLanguage` is true. */
  languageOptions: SttLanguageCode[];
  enablePartialResultsStabilization: boolean;
  partialResultsStability: SttPartialStability;
}

export const DEFAULT_STT_SETTINGS: SttSettings = {
  enabled: true,
  provider: "aws_transcribe",
  region: "",
  languageCode: "en-US",
  identifyLanguage: false,
  languageOptions: ["en-US", "zh-CN"],
  enablePartialResultsStabilization: true,
  partialResultsStability: "medium",
};

/**
 * State machine states for the composer STT controller:
 * - Normal flow: `idle -> connecting -> recording -> finalizing -> idle`
 * - Immediate send flow: `recording -> finalizing -> sending -> idle`
 * - Error flow: `* -> error -> idle`
 */
export type SttMachineState =
  "idle" | "connecting" | "recording" | "finalizing" | "sending" | "error";

export interface SttTranscriptEvent {
  resultId: string;
  transcript: string;
  isPartial: boolean;
  languageCode?: string;
}

export interface SttSessionCallbacks {
  onReady: () => void;
  onTranscript: (event: SttTranscriptEvent) => void;
  onError: (message: string) => void;
}

export interface SttActiveSession {
  /**
   * Immediately stop microphone capture, flush any remaining audio, send the
   * end-of-stream frame to the STT provider, and wait for all final
   * transcription results before resolving.
   */
  finalize: () => Promise<{ durationMs: number }>;
  /**
   * Immediately abort the session and release all microphone and network
   * resources without waiting for finalization.
   */
  abort: () => void;
}

export interface SttProvider {
  readonly id: SttProviderId;
  startSession: (
    callbacks: SttSessionCallbacks,
    options?: { surface?: string },
  ) => Promise<SttActiveSession>;
}

/**
 * Where STT was invoked, recorded on usage logs for admin visibility.
 */
export const STT_SURFACES = [
  "student_assistant",
  "teacher_assistant",
  "wrong_answer_coach",
  "simulation_editor",
] as const;

export type SttSurface = (typeof STT_SURFACES)[number];

export function isSttSurface(value: unknown): value is SttSurface {
  return (
    typeof value === "string" &&
    (STT_SURFACES as readonly string[]).includes(value)
  );
}
