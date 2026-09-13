"use client";

import { Sparkles } from "lucide-react";
import { useAssistant } from "./assistant-context";

/**
 * The sidebar row that opens the assistant. Renders nothing until the config
 * says an assistant exists for this role, so the rail never shows a button that
 * would open an empty panel.
 */
interface AssistantLauncherProps {
  onOpen?: () => void;
}

export function AssistantLauncher({ onOpen }: AssistantLauncherProps) {
  const { config, open, setOpen } = useAssistant();
  if (!config?.available) return null;

  const label =
    config.audience === "teacher" ? "Teaching assistant" : "Study assistant";

  return (
    <button
      type="button"
      onClick={() => {
        setOpen(true);
        // Closes the mobile drawer, which would otherwise sit over the panel.
        onOpen?.();
      }}
      aria-label={`Open ${label.toLowerCase()}`}
      aria-expanded={open}
      className="mb-2 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
    >
      <Sparkles className="size-4 text-sidebar-primary" />
      {label}
    </button>
  );
}
