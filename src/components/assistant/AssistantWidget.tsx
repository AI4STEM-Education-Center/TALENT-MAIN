"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Move, Sparkles, SquarePen, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AssistantHistory } from "./AssistantHistory";
import { AssistantComposer } from "./AssistantComposer";
import { useAssistantConversation } from "./use-assistant-conversation";
import {
  clampPanelRect,
  defaultPanelRect,
  forgetPanelRect,
  movePanelRect,
  readStoredPanelRect,
  resizePanelRect,
  storePanelRect,
  type PanelRect,
  type ResizeEdge,
} from "./panel-geometry";
import { useAssistant } from "./assistant-context";
import { AssistantTranscript } from "./AssistantTranscript";
import { usePanelDrag } from "./use-panel-drag";

/**
 * The eight grab targets around the panel. Edges are thin strips inset past the
 * corners, so a corner drag — which resizes both axes at once — always wins the
 * hit test over the two edges it meets.
 */
const RESIZE_HANDLES: { edge: ResizeEdge; className: string }[] = [
  { edge: "n", className: "inset-x-3 top-0 h-1.5 cursor-ns-resize" },
  { edge: "s", className: "inset-x-3 bottom-0 h-1.5 cursor-ns-resize" },
  { edge: "w", className: "inset-y-3 left-0 w-1.5 cursor-ew-resize" },
  { edge: "e", className: "inset-y-3 right-0 w-1.5 cursor-ew-resize" },
  { edge: "nw", className: "left-0 top-0 size-2.5 cursor-nwse-resize" },
  { edge: "ne", className: "right-0 top-0 size-2.5 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 size-2.5 cursor-nesw-resize" },
  { edge: "se", className: "bottom-0 right-0 size-2.5 cursor-nwse-resize" },
];

export function AssistantWidget() {
  const { config, open, setOpen } = useAssistant();
  const conversation = useAssistantConversation(config);
  const {
    bubbles,
    activity,
    notice,
    historyOpen,
    setHistoryOpen,
    startNewConversation,
    openHistory,
  } = conversation;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Where the panel sits and how big it is. null until the first client-side
  // measurement, and unused on narrow screens, where the panel stays docked
  // across the bottom of the viewport — there is nowhere to drag it to.
  const [rect, setRect] = useState<PanelRect | null>(null);
  const [floating, setFloating] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Decide whether there is room to float, restore the remembered geometry, and
  // keep the panel inside the window as it resizes. Measuring in an effect
  // rather than during render keeps the server markup and the first client pass
  // in agreement.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 640px)");
    const sync = () => {
      setFloating(wide.matches);
      if (!wide.matches) return;
      const { innerWidth: vw, innerHeight: vh } = window;
      setRect((prev) =>
        clampPanelRect(
          prev ?? readStoredPanelRect() ?? defaultPanelRect(vw, vh),
          vw,
          vh,
        ),
      );
    };
    sync();
    window.addEventListener("resize", sync);
    wide.addEventListener("change", sync);
    return () => {
      window.removeEventListener("resize", sync);
      wide.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, activity]);

  // The gesture itself runs outside React — see use-panel-drag.ts. The panel is
  // written once per animation frame instead of once per pointer event, and this
  // component renders once, here, when the gesture ends.
  const commitRect = useCallback((next: PanelRect) => {
    setRect(next);
    // Written once per gesture, not once per frame.
    storePanelRect(next);
  }, []);

  const beginDrag = usePanelDrag({
    panelRef,
    rect,
    enabled: floating,
    onCommit: commitRect,
  });
  const beginMove = useMemo(() => beginDrag("move"), [beginDrag]);

  /**
   * The keyboard path to the same two gestures: arrows nudge the panel, Shift
   * takes bigger steps, Alt resizes from the bottom-right corner.
   */
  const nudge = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = deltas[event.key];
    if (!delta || !rect) return;
    event.preventDefault();
    const { innerWidth: vw, innerHeight: vh } = window;
    const next = event.altKey
      ? resizePanelRect(rect, "se", delta[0], delta[1], vw, vh)
      : movePanelRect(rect, delta[0], delta[1], vw, vh);
    setRect(next);
    storePanelRect(next);
  };

  /** Back to the bottom-right dock, for a panel dragged somewhere unhelpful. */
  const resetLayout = () => {
    forgetPanelRect();
    setRect(defaultPanelRect(window.innerWidth, window.innerHeight));
  };

  if (!config?.available) return null;

  const isTeacher = config.audience === "teacher";
  // Narrowed once, so the style below can read `rect` without re-checking it.
  const floatingPanel = floating && rect !== null;

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          // react-doctor-disable-next-line react-doctor/prefer-html-dialog -- this is a docked non-modal chat panel, not a modal; <dialog> would change stacking and focus semantics
          role="dialog"
          aria-label={isTeacher ? "Teaching assistant" : "Study assistant"}
          style={
            floatingPanel
              ? {
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                }
              : undefined
          }
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden rounded-[var(--radius)] border-[length:var(--border-width)] border-border bg-background [box-shadow:var(--shadow-overlay)]",
            // Narrow screens keep the old docked strip; anywhere with room, the
            // position and size come from `rect` instead.
            floatingPanel
              ? "max-h-none"
              : "inset-x-2 bottom-2 max-h-[min(80vh,640px)]",
            // `data-dragging` is set imperatively for the duration of a gesture
            // (globals.css turns off selection and hit-testing under it), so a
            // drag never costs a React render just to change a class.
            floatingPanel && "assistant-panel",
          )}
        >
          <header
            onPointerDown={(event) => {
              // The header buttons keep their clicks; only the bare strip drags.
              if ((event.target as HTMLElement).closest("button")) return;
              beginMove(event);
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest("button")) return;
              resetLayout();
            }}
            className={cn(
              "flex items-center gap-2 border-b border-border px-3 py-2",
              floatingPanel && "cursor-move touch-none",
            )}
          >
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {isTeacher ? "Teaching assistant" : "Study assistant"}
              </p>
            </div>
            {floatingPanel && (
              <button
                type="button"
                onPointerDown={beginMove}
                onKeyDown={nudge}
                aria-label="Move or resize the assistant panel"
                title="Drag to move · drag an edge to resize · arrow keys move, Alt+arrows resize · double-click the header to reset"
                className="cursor-move touch-none rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Move className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                void (historyOpen ? setHistoryOpen(false) : openHistory())
              }
              aria-label="Conversation history"
              aria-pressed={historyOpen}
              className={cn(
                "rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground",
                historyOpen
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <History className="size-4" />
            </button>
            {bubbles.length > 0 && (
              <button
                type="button"
                onClick={startNewConversation}
                aria-label="New conversation"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <SquarePen className="size-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>

          {historyOpen && <AssistantHistory conversation={conversation} />}

          {/*
            Kept mounted while the history list is up rather than swapped out, so
            returning to the conversation returns to the same scroll position.
          */}
          <div
            ref={scrollRef}
            className={cn(
              "flex-1 space-y-3 overflow-y-auto px-3 py-3",
              historyOpen && "hidden",
            )}
          >
            <AssistantTranscript
              bubbles={bubbles}
              activity={activity}
              greeting={config.greeting}
            />
          </div>

          {notice && (
            <p className="border-t border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              {notice}
            </p>
          )}

          {!historyOpen && (
            <AssistantComposer
              conversation={conversation}
              isTeacher={isTeacher}
            />
          )}

          {/*
            Invisible grab strips around the border. The pointer shape is the
            affordance, as it is for a native window; the keyboard equivalent is
            Alt+arrows on the move button in the header.
          */}
          {floatingPanel &&
            RESIZE_HANDLES.map((handle) => (
              // react-doctor-disable-next-line react-doctor/no-static-element-interactions -- pointer-only resize grip; the keyboard path is Alt+arrows on the header's move button
              <div
                key={handle.edge}
                onPointerDown={beginDrag(handle.edge)}
                aria-hidden="true"
                className={cn("absolute touch-none", handle.className)}
              />
            ))}
        </div>
      )}
    </>
  );
}
