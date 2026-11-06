"use client";

import { AlertCircle, Loader2, Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SttMachineState } from "@/lib/stt/types";

export interface SttMicButtonProps {
  state: SttMachineState;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
}

const STATE_LABELS: Record<SttMachineState, string> = {
  idle: "Start voice input",
  error: "Start voice input",
  connecting: "Cancel connecting voice input",
  recording: "Stop voice input",
  finalizing: "Finalizing voice input…",
  sending: "Finalizing voice input…",
};

function MicIcon({ state }: { state: SttMachineState }) {
  if (state === "connecting" || state === "finalizing" || state === "sending") {
    return <Loader2 className="size-4 animate-spin" aria-hidden />;
  }
  if (state === "recording") {
    return <Square className="size-3.5 fill-current" aria-hidden />;
  }
  return <Mic className="size-4" aria-hidden />;
}

/**
 * Start / Stop Speech-to-Text button that visually indicates the current
 * recording state:
 * - Idle / Error: microphone icon (`Start voice input`)
 * - Connecting: spinning loader (`Cancel connecting voice input`, clickable to cancel)
 * - Recording: pulsing active indicator + stop icon (`Stop voice input`)
 * - Finalizing / Sending: disabled button with spinning loader (`Finalizing voice input…`)
 */
export function SttMicButton({
  state,
  disabled = false,
  onToggle,
  className,
}: SttMicButtonProps) {
  const isRecording = state === "recording";
  const isFinalizing = state === "finalizing" || state === "sending";
  const label = STATE_LABELS[state];

  return (
    <Button
      type="button"
      variant={isRecording ? "destructive" : "ghost"}
      size="icon"
      className={cn(
        "relative size-9 shrink-0 transition-colors",
        isRecording && "motion-safe:animate-pulse",
        state === "error" && "text-destructive hover:text-destructive",
        className,
      )}
      aria-label={label}
      title={label}
      disabled={disabled || isFinalizing}
      onClick={onToggle}
    >
      <MicIcon state={state} />
    </Button>
  );
}

export function SttErrorBanner({
  error,
  onDismiss,
  className,
}: {
  error: string | null;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center justify-between gap-2 border-t border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive",
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        <AlertCircle className="size-3.5 shrink-0" aria-hidden />
        <span>{error}</span>
      </span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss voice input error"
          className="rounded p-0.5 hover:bg-destructive/20"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
