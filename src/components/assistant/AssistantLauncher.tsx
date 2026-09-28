"use client";

import { ChevronRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistant } from "./assistant-context";

/**
 * The sidebar button that opens the assistant. Renders nothing until the config
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
    <Button
      type="button"
      onClick={() => {
        setOpen(true);
        // Closes the mobile drawer, which would otherwise sit over the panel.
        onOpen?.();
      }}
      aria-label={`Open ${label.toLowerCase()}`}
      aria-expanded={open}
      aria-haspopup="dialog"
      className="mb-3 h-auto min-h-11 w-full cursor-pointer justify-start gap-2.5 rounded-lg border border-sidebar-primary bg-sidebar-primary px-3 py-3 text-left font-semibold text-sidebar-primary-foreground shadow-sm hover:bg-sidebar-primary/90 active:bg-sidebar-primary/80 focus-visible:ring-sidebar-ring focus-visible:ring-offset-sidebar"
    >
      <Sparkles aria-hidden="true" />
      <span className="flex-1">{label}</span>
      <ChevronRight aria-hidden="true" />
    </Button>
  );
}
