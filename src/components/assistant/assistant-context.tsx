"use client";

// Splits the assistant into a trigger and a panel so the two can live in
// different parts of the dashboard chrome: the trigger sits in the sidebar
// (above the signed-in user), while the panel stays an overlay anchored to the
// viewport — 26rem of chat does not fit inside a 16rem rail.
//
// The provider owns what both halves need — whether the assistant is available
// at all, and whether the panel is open — so the config is fetched once per
// dashboard mount rather than once per consumer.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AttachmentKindInfo } from "@/lib/assistant/attachments";

export type WidgetConfig = {
  available: boolean;
  audience?: "student" | "teacher";
  greeting?: string;
  attachmentKinds?: AttachmentKindInfo[];
  maxAttachments?: number;
  maxAttachmentBytes?: number;
};

type AssistantContextValue = {
  /** null while the config request is still in flight. */
  config: WidgetConfig | null;
  open: boolean;
  setOpen: (open: boolean) => void;
};

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function useAssistant(): AssistantContextValue {
  const value = useContext(AssistantContext);
  if (!value) {
    throw new Error("useAssistant must be used inside <AssistantProvider>");
  }
  return value;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/assistant/config");
        if (!res.ok) return;
        const data = (await res.json()) as WidgetConfig;
        if (!cancelled) setConfig(data);
      } catch {
        // Offline or signed out mid-load — the assistant simply stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ config, open, setOpen }), [config, open]);

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}
