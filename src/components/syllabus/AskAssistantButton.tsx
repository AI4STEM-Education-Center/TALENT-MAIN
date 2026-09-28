"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistant } from "@/components/assistant/assistant-context";

/**
 * Opens the sidebar assistant, which can read the syllabus through its
 * syllabus skill. Renders nothing when the assistant is off for this role, so
 * the page never offers a chat that isn't there.
 */
export function AskAssistantButton() {
  const { config, setOpen } = useAssistant();
  if (!config?.available) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      <Sparkles className="size-4" /> Ask about the syllabus
    </Button>
  );
}
